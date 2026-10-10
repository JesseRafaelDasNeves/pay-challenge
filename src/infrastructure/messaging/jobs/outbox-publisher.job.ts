import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  OUTBOX_REPOSITORY_PORT,
  type OutboxRepositoryPort,
} from '../../../application/ports/outbox.repository.port.js';
import { SqsPublisherService } from '../sqs/sqs-publisher.service.js';
import { envConfig } from '../../config/env.config.js';

@Injectable()
export class OutboxPublisherJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherJob.name);
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private isShuttingDown = false;

  constructor(
    @Inject(OUTBOX_REPOSITORY_PORT)
    private readonly outboxRepository: OutboxRepositoryPort,
    private readonly sqsPublisher: SqsPublisherService,
  ) {}

  public onModuleInit(): void {
    // Polling a cada 1000ms
    this.timer = setInterval(() => {
      void this.processDueMessages();
    }, 1000);
  }

  public onModuleDestroy(): void {
    this.isShuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async processDueMessages(): Promise<number> {
    if (this.isProcessing || this.isShuttingDown) {
      return 0;
    }

    this.isProcessing = true;
    let publishedCount = 0;

    try {
      // Busca mensagens prontas com lock pessimista SKIP LOCKED no PostgreSQL
      const messages = await this.outboxRepository.fetchDueMessages(50);

      for (const msg of messages) {
        if (this.isShuttingDown) break;

        try {
          const body = JSON.stringify(msg.payload);
          await this.sqsPublisher.publish(
            envConfig.sqs.queueUrl,
            body,
            msg.aggregateId,
            msg.id, // ID único para deduplicação no FIFO
          );

          msg.markPublished(new Date());
          await this.outboxRepository.update(msg);
          publishedCount++;
        } catch (error: any) {
          this.logger.warn(
            `Falha ao despachar mensagem outbox ${msg.id} para SQS: ${error?.message || error}. Agendando retentativa.`,
          );
          msg.scheduleRetry(new Date(), error?.message || String(error));
          await this.outboxRepository.update(msg);
        }
      }
    } catch (error) {
      this.logger.error('Erro no ciclo de polling do OutboxPublisherJob:', error);
    } finally {
      this.isProcessing = false;
    }

    return publishedCount;
  }
}
