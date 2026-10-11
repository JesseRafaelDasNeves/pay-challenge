import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SqsPublisherService } from './sqs-publisher.service.js';
import { envConfig } from '../../config/env.config.js';
import { ProcessWagerTransactionUseCase } from '../../../application/use-cases/process-wager-transaction.use-case.js';
import { SqsWagerMessageDto } from '../../../application/dtos/sqs-wager-message.dto.js';
import {
  METRICS_COLLECTOR_PORT,
  type MetricsCollectorPort,
} from '../../../application/ports/metrics-collector.port.js';

@Injectable()
export class SqsConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsConsumerService.name);
  private readonly client: SQSClient;
  private isRunning = false;
  private isShuttingDown = false;

  constructor(
    private readonly sqsPublisher: SqsPublisherService,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    @Optional()
    @Inject(METRICS_COLLECTOR_PORT)
    private readonly metrics?: MetricsCollectorPort,
  ) {
    this.client = this.sqsPublisher.getClient();
  }

  public onModuleInit(): void {
    this.isRunning = true;
    void this.pollLoop();
  }

  public onModuleDestroy(): void {
    this.isShuttingDown = true;
    this.isRunning = false;
  }

  private async pollLoop(): Promise<void> {
    while (this.isRunning && !this.isShuttingDown) {
      try {
        const command = new ReceiveMessageCommand({
          QueueUrl: envConfig.sqs.queueUrl,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 5, // Long polling
          VisibilityTimeout: 30,
        });

        const response = await this.client.send(command);

        if (response.Messages && response.Messages.length > 0) {
          for (const msg of response.Messages) {
            if (this.isShuttingDown) break;
            await this.processMessage(msg);
          }
        }
      } catch (error) {
        if (!this.isShuttingDown) {
          this.logger.warn(`Erro no polling do SQS: ${error}`);
          // Pausa breve em caso de falha de conexão com o broker
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }
  }

  private async processMessage(msg: { MessageId?: string; ReceiptHandle?: string; Body?: string }): Promise<void> {
    if (!msg.ReceiptHandle || !msg.Body) {
      return;
    }

    try {
      const parsed = JSON.parse(msg.Body);
      const dto = plainToInstance(SqsWagerMessageDto, parsed);
      const errors = await validate(dto);

      if (errors.length > 0) {
        this.logger.error(
          JSON.stringify({
            event: 'SQS_MESSAGE_PAYLOAD_INVALID',
            messageId: msg.MessageId,
            errors: errors.map((e) => e.constraints),
          }),
        );
        // Não dá ACK em mensagem malformada caso queira análise manual ou deixa expirar para DLQ
        return;
      }

      const txData = dto.data;
      const idempotencyKey =
        txData.idempotencyKey || `${txData.providerId}:${txData.externalTransactionId}`;
      const correlationId = dto.messageId || txData.idempotencyKey || msg.MessageId;

      // Executa o use case compartilhado na mesma transação atômica
      await this.processWagerUseCase.execute({
        idempotencyKey,
        providerId: txData.providerId,
        externalTransactionId: txData.externalTransactionId,
        playerId: txData.playerId,
        walletId: txData.walletId,
        roundId: txData.roundId,
        gameId: txData.gameId,
        kind: txData.toDomainKind(),
        money: txData.money,
        referenceExternalTransactionId: txData.referenceExternalTransactionId,
        consumerName: 'wager-transactions-consumer',
        consumerMessageId: msg.MessageId || dto.messageId,
        correlationId,
      });

      // ACK somente após o commit com sucesso no PostgreSQL
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: envConfig.sqs.queueUrl,
          ReceiptHandle: msg.ReceiptHandle,
        }),
      );
    } catch (error: any) {
      // Erros transitórios de banco ou rede não dão ACK, permitindo reentrega com backoff ou DLQ
      this.metrics?.recordRetry('sqs');
      this.logger.error(
        JSON.stringify({
          event: 'SQS_MESSAGE_PROCESSING_FAILED',
          messageId: msg.MessageId,
          error: error?.message || String(error),
        }),
      );
    }
  }
}
