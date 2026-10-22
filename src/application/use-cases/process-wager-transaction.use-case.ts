import {
  Inject,
  Injectable,
  Logger,
  Optional,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { UNIT_OF_WORK_PORT, type UnitOfWorkPort } from '../ports/unit-of-work.port.js';
import {
  METRICS_COLLECTOR_PORT,
  type MetricsCollectorPort,
} from '../ports/metrics-collector.port.js';
import { Money, type MoneyProps } from '../../domain/shared/money.value-object.js';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status.enum.js';
import { FailureCode } from '../../domain/wagering/failure-code.enum.js';
import { WagerTransaction } from '../../domain/wagering/wager-transaction.aggregate.js';
import { computePayloadHash } from '../../domain/shared/canonical-json.util.js';
import { InboxMessage } from '../../domain/messaging/inbox-message.entity.js';
import type { WagerTransactionKindUseCase } from './wager-kinds/wager-transaction-kind.use-case.js';
import { ProcessBetTransactionUseCase } from './wager-kinds/process-bet-transaction.use-case.js';
import { ProcessWinTransactionUseCase } from './wager-kinds/process-win-transaction.use-case.js';
import { ProcessLossTransactionUseCase } from './wager-kinds/process-loss-transaction.use-case.js';
import { ProcessRefundTransactionUseCase } from './wager-kinds/process-refund-transaction.use-case.js';
import { ProcessRollbackTransactionUseCase } from './wager-kinds/process-rollback-transaction.use-case.js';

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  consumerMessageId?: string;
  consumerName?: string;
  correlationId?: string;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

@Injectable()
export class ProcessWagerTransactionUseCase {
  private readonly logger = new Logger(ProcessWagerTransactionUseCase.name);
  private readonly kindUseCases: ReadonlyMap<WagerTransactionKind, WagerTransactionKindUseCase>;

  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly betUseCase: ProcessBetTransactionUseCase,
    private readonly winUseCase: ProcessWinTransactionUseCase,
    private readonly lossUseCase: ProcessLossTransactionUseCase,
    private readonly refundUseCase: ProcessRefundTransactionUseCase,
    private readonly rollbackUseCase: ProcessRollbackTransactionUseCase,
    @Optional()
    @Inject(METRICS_COLLECTOR_PORT)
    private readonly metrics?: MetricsCollectorPort,
  ) {
    const handlers: WagerTransactionKindUseCase[] = [
      this.betUseCase,
      this.winUseCase,
      this.lossUseCase,
      this.refundUseCase,
      this.rollbackUseCase,
    ];
    this.kindUseCases = new Map(handlers.map((handler) => [handler.kind, handler]));
  }

  public async execute(
    command: ProcessWagerTransactionCommand,
  ): Promise<ProcessWagerTransactionResult> {
    const startMs = Date.now();
    const money = Money.from(command.money);
    const correlationId = command.correlationId || randomUUID();
    const now = new Date();

    this.logger.log(
      JSON.stringify({
        event: 'TRANSACTION_PROCESSING_STARTED',
        correlationId,
        messageId: command.consumerMessageId ?? null,
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        walletId: command.walletId,
        kind: command.kind,
      }),
    );

    // 1. Hash canônico para integridade de idempotência
    const payloadToHash = {
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: {
        amount: money.amount,
        currency: money.currency,
      },
      referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
    };
    const payloadHash = computePayloadHash(payloadToHash);

    try {
      const result = await this.executeInternal(command, correlationId, now, payloadHash, money);
      const durationMs = Date.now() - startMs;

      if (result.idempotentReplay) {
        this.metrics?.recordDuplicateDetected();
        this.logger.log(
          JSON.stringify({
            event: 'TRANSACTION_IDEMPOTENT_REPLAY',
            correlationId,
            messageId: command.consumerMessageId ?? null,
            transactionId: result.transactionId,
            providerId: command.providerId,
            walletId: command.walletId,
            status: result.status,
            durationMs,
          }),
        );
      } else if (result.status === WagerTransactionStatus.Rejected) {
        this.metrics?.recordTransaction(result.status, durationMs);
        this.logger.warn(
          JSON.stringify({
            event: 'TRANSACTION_REJECTED',
            correlationId,
            messageId: command.consumerMessageId ?? null,
            transactionId: result.transactionId,
            providerId: command.providerId,
            walletId: command.walletId,
            kind: command.kind,
            failureCode: result.failureCode,
            durationMs,
          }),
        );
      } else if (result.status === WagerTransactionStatus.PendingReference) {
        this.metrics?.recordTransaction(result.status, durationMs);
        this.logger.log(
          JSON.stringify({
            event: 'TRANSACTION_PENDING_REFERENCE',
            correlationId,
            messageId: command.consumerMessageId ?? null,
            transactionId: result.transactionId,
            providerId: command.providerId,
            walletId: command.walletId,
            kind: command.kind,
            referenceExternalTransactionId: command.referenceExternalTransactionId ?? null,
            durationMs,
          }),
        );
      } else {
        this.metrics?.recordTransaction(result.status, durationMs);
        this.logger.log(
          JSON.stringify({
            event: 'TRANSACTION_PROCESSED',
            correlationId,
            messageId: command.consumerMessageId ?? null,
            transactionId: result.transactionId,
            providerId: command.providerId,
            walletId: command.walletId,
            kind: command.kind,
            durationMs,
          }),
        );
      }

      return result;
    } catch (error: any) {
      const durationMs = Date.now() - startMs;
      if (
        !(error instanceof ConflictException) &&
        !(error instanceof NotFoundException) &&
        !(error instanceof UnprocessableEntityException)
      ) {
        this.metrics?.recordTransaction(WagerTransactionStatus.Failed, durationMs);
      }
      this.logger.error(
        JSON.stringify({
          event: 'TRANSACTION_PROCESSING_FAILED',
          correlationId,
          messageId: command.consumerMessageId ?? null,
          providerId: command.providerId,
          walletId: command.walletId,
          error: error?.message || String(error),
          durationMs,
        }),
      );
      throw error;
    }
  }

  private async executeInternal(
    command: ProcessWagerTransactionCommand,
    correlationId: string,
    now: Date,
    payloadHash: string,
    money: Money,
  ): Promise<ProcessWagerTransactionResult> {
    // 2. Execução dentro da transação atômica gerenciada por UnitOfWork
    try {
      return await this.unitOfWork.executeInTransaction(async (ctx) => {
        // 2.1 Lock Pessimista na Carteira (SELECT ... FOR UPDATE)
        // A walletId é a unidade estrita de concorrência. Adquirir o lock primeiro
        // serializa operações na mesma carteira e garante leitura da versão mais recente do banco.
        const wallet = await ctx.wallets.findById(command.walletId, 'pessimistic_write');
        if (!wallet) {
          throw new NotFoundException(`Carteira com ID ${command.walletId} não encontrada.`);
        }

        if (wallet.playerId !== command.playerId) {
          throw new UnprocessableEntityException('A carteira informada não pertence ao jogador.');
        }

        if (wallet.currency !== money.currency) {
          throw new UnprocessableEntityException(
            `Incompatibilidade de moeda: carteira em ${wallet.currency} e operação em ${money.currency}.`,
          );
        }

        // 2.2 Checagem de Idempotência Persistente (com o lock da carteira já adquirido)
        let existingTx = await ctx.transactions.findByIdempotencyKey(command.idempotencyKey);
        if (!existingTx) {
          existingTx = await ctx.transactions.findByProviderAndExternalId(
            command.providerId,
            command.externalTransactionId,
          );
        }

        if (existingTx) {
          if (!existingTx.matchesPayload(payloadHash)) {
            throw new ConflictException({
              statusCode: 409,
              error: 'Conflict',
              message:
                'Conflito de idempotência: a chave informada já foi processada com um payload de negócio diferente.',
              failureCode: FailureCode.IdempotencyPayloadMismatch,
            });
          }

          // Replay Idêntico
          return {
            transactionId: existingTx.id,
            status: existingTx.status,
            balance: wallet.balance.toJSON(),
            idempotentReplay: true,
            failureCode: existingTx.failureCode,
          };
        }

        // 2.3 Deduplicação Transactional Inbox (quando mensagem originada de mensageria SQS)
        if (command.consumerName && command.consumerMessageId) {
          const alreadyReceived = await ctx.inbox.exists(
            command.consumerName,
            command.consumerMessageId,
          );
          if (alreadyReceived) {
            return {
              transactionId: randomUUID(),
              status: WagerTransactionStatus.Processed,
              balance: wallet.balance.toJSON(),
              idempotentReplay: true,
            };
          }

          const inboxMsg = InboxMessage.receive({
            consumerName: command.consumerName,
            messageId: command.consumerMessageId,
            payloadHash,
            receivedAt: now,
          });
          inboxMsg.markProcessed(now);
          await ctx.inbox.save(inboxMsg);
        }

        // 2.4 Validação do Use Case específico por Kind e Instanciação da Transação
        const kindUseCase = this.kindUseCases.get(command.kind);
        if (!kindUseCase) {
          throw new UnprocessableEntityException(`Tipo de operação desconhecido: ${command.kind}`);
        }

        const txId = randomUUID();
        const tx = WagerTransaction.create({
          id: txId,
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
          idempotencyKey: command.idempotencyKey,
          payloadHash,
          walletId: command.walletId,
          playerId: command.playerId,
          roundId: command.roundId,
          gameId: command.gameId,
          kind: command.kind,
          money,
          referenceExternalTransactionId: command.referenceExternalTransactionId,
          createdAt: now,
        });

        // 2.5 Delegação das Regras de Negócio Específicas por Kind
        return kindUseCase.execute({
          ctx,
          wallet,
          tx,
          money,
          correlationId,
          now,
        });
      });
    } catch (error: any) {
      // Tratamento de race condition em Unique Constraint (código PostgreSQL 23505)
      if (error?.code === '23505' || String(error?.message).includes('uq_wager_tx')) {
        this.metrics?.recordLockConflict();
        this.logger.warn(
          JSON.stringify({
            event: 'TRANSACTION_LOCK_COLLISION_RESOLVED',
            correlationId,
            providerId: command.providerId,
            externalTransactionId: command.externalTransactionId,
            idempotencyKey: command.idempotencyKey,
          }),
        );
        return this.unitOfWork.executeInTransaction(async (ctx) => {
          let existingTx = await ctx.transactions.findByIdempotencyKey(command.idempotencyKey);
          if (!existingTx) {
            existingTx = await ctx.transactions.findByProviderAndExternalId(
              command.providerId,
              command.externalTransactionId,
            );
          }

          if (existingTx) {
            if (!existingTx.matchesPayload(payloadHash)) {
              throw new ConflictException({
                statusCode: 409,
                error: 'Conflict',
                message:
                  'Conflito de idempotência: a chave informada já foi processada com um payload de negócio diferente.',
                failureCode: FailureCode.IdempotencyPayloadMismatch,
              });
            }

            const currentWallet = await ctx.wallets.findById(existingTx.walletId);
            return {
              transactionId: existingTx.id,
              status: existingTx.status,
              balance: currentWallet ? currentWallet.balance.toJSON() : existingTx.money.toJSON(),
              idempotentReplay: true,
              failureCode: existingTx.failureCode,
            };
          }
          throw error;
        });
      }
      throw error;
    }
  }
}
