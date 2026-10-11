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
import { Money, MoneyProps } from '../../domain/shared/money.value-object.js';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status.enum.js';
import { FailureCode } from '../../domain/wagering/failure-code.enum.js';
import { WagerTransaction } from '../../domain/wagering/wager-transaction.aggregate.js';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger.entity.js';
import { LedgerDirection } from '../../domain/wallet/ledger-direction.enum.js';
import { computePayloadHash } from '../../domain/shared/canonical-json.util.js';
import { InboxMessage } from '../../domain/messaging/inbox-message.entity.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.entity.js';
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/messaging/integration-event.abstract.js';

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

  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly unitOfWork: UnitOfWorkPort,
    @Optional()
    @Inject(METRICS_COLLECTOR_PORT)
    private readonly metrics?: MetricsCollectorPort,
  ) {}

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

        // 2.4 Instanciação da Transação
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

        // 2.5 Regras de Negócio Específicas por Kind
        switch (command.kind) {
          case WagerTransactionKind.Bet: {
            if (wallet.balance.isLessThan(money)) {
              tx.reject(FailureCode.InsufficientFunds, now);
              await ctx.transactions.save(tx);

              const rejectedEvent = new WagerTransactionRejected({
                eventId: randomUUID(),
                aggregateId: tx.id,
                correlationId,
                occurredAt: now,
                data: {
                  transactionId: tx.id,
                  providerId: tx.providerId,
                  externalTransactionId: tx.externalTransactionId,
                  walletId: wallet.id,
                  playerId: wallet.playerId,
                  roundId: tx.roundId,
                  gameId: tx.gameId,
                  kind: tx.kind,
                  money: money.toJSON(),
                  failureCode: FailureCode.InsufficientFunds,
                },
              });
              await ctx.outbox.save(OutboxMessage.enqueue(rejectedEvent));

              return {
                transactionId: tx.id,
                status: tx.status,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
                failureCode: tx.failureCode,
              };
            }

            const mutation = wallet.debit(money, now);
            tx.markProcessed(undefined, now);

            const ledgerEntry = WalletLedgerEntry.create({
              id: randomUUID(),
              walletId: wallet.id,
              transactionId: tx.id,
              direction: LedgerDirection.Debit,
              money,
              balanceBefore: mutation.balanceBefore,
              balanceAfter: mutation.balanceAfter,
              createdAt: now,
            });

            await ctx.wallets.save(wallet);
            await ctx.transactions.save(tx);
            await ctx.ledgers.save(ledgerEntry);

            await this.publishSuccessEvents(ctx, wallet, tx, ledgerEntry, correlationId, now);

            return {
              transactionId: tx.id,
              status: tx.status,
              balance: wallet.balance.toJSON(),
              idempotentReplay: false,
            };
          }

          case WagerTransactionKind.Win: {
            const mutation = wallet.credit(money, now);
            tx.markProcessed(undefined, now);

            const ledgerEntry = WalletLedgerEntry.create({
              id: randomUUID(),
              walletId: wallet.id,
              transactionId: tx.id,
              direction: LedgerDirection.Credit,
              money,
              balanceBefore: mutation.balanceBefore,
              balanceAfter: mutation.balanceAfter,
              createdAt: now,
            });

            await ctx.wallets.save(wallet);
            await ctx.transactions.save(tx);
            await ctx.ledgers.save(ledgerEntry);

            await this.publishSuccessEvents(ctx, wallet, tx, ledgerEntry, correlationId, now);

            return {
              transactionId: tx.id,
              status: tx.status,
              balance: wallet.balance.toJSON(),
              idempotentReplay: false,
            };
          }

          case WagerTransactionKind.Loss: {
            tx.markProcessed(undefined, now);
            await ctx.transactions.save(tx);

            const processedEvent = new WagerTransactionProcessed({
              eventId: randomUUID(),
              aggregateId: tx.id,
              correlationId,
              occurredAt: now,
              data: {
                transactionId: tx.id,
                providerId: tx.providerId,
                externalTransactionId: tx.externalTransactionId,
                walletId: wallet.id,
                playerId: wallet.playerId,
                roundId: tx.roundId,
                gameId: tx.gameId,
                kind: tx.kind,
                money: money.toJSON(),
              },
            });
            await ctx.outbox.save(OutboxMessage.enqueue(processedEvent));

            return {
              transactionId: tx.id,
              status: tx.status,
              balance: wallet.balance.toJSON(),
              idempotentReplay: false,
            };
          }

          case WagerTransactionKind.Refund: {
            const refTx = await ctx.transactions.findReferenceTransaction(
              command.providerId,
              command.referenceExternalTransactionId!,
            );

            if (!refTx) {
              // Referência fora de ordem: armazena como PENDING_REFERENCE para reprocessamento
              tx.markPendingReference();
              await ctx.transactions.save(tx);

              const pendingEvent = new WagerTransactionPendingReference({
                eventId: randomUUID(),
                aggregateId: tx.id,
                correlationId,
                occurredAt: now,
                data: {
                  transactionId: tx.id,
                  providerId: tx.providerId,
                  externalTransactionId: tx.externalTransactionId,
                  referenceExternalTransactionId: command.referenceExternalTransactionId!,
                  walletId: wallet.id,
                  playerId: wallet.playerId,
                  kind: tx.kind,
                },
              });
              await ctx.outbox.save(OutboxMessage.enqueue(pendingEvent));

              return {
                transactionId: tx.id,
                status: tx.status,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
              };
            }

            // Validações da referência
            if (refTx.kind !== WagerTransactionKind.Bet) {
              return this.rejectTx(
                ctx,
                tx,
                wallet,
                FailureCode.InvalidReferenceTransaction,
                correlationId,
                now,
              );
            }
            if (refTx.status !== WagerTransactionStatus.Processed) {
              return this.rejectTx(
                ctx,
                tx,
                wallet,
                FailureCode.InvalidTransactionState,
                correlationId,
                now,
              );
            }
            if (refTx.roundId !== tx.roundId) {
              return this.rejectTx(ctx, tx, wallet, FailureCode.RoundMismatch, correlationId, now);
            }
            if (!refTx.money.equals(money)) {
              return this.rejectTx(ctx, tx, wallet, FailureCode.AmountMismatch, correlationId, now);
            }

            const mutation = wallet.credit(money, now);
            tx.markProcessed(refTx.id, now);

            const ledgerEntry = WalletLedgerEntry.create({
              id: randomUUID(),
              walletId: wallet.id,
              transactionId: tx.id,
              direction: LedgerDirection.Credit,
              money,
              balanceBefore: mutation.balanceBefore,
              balanceAfter: mutation.balanceAfter,
              createdAt: now,
            });

            await ctx.wallets.save(wallet);
            await ctx.transactions.save(tx);
            await ctx.ledgers.save(ledgerEntry);

            await this.publishSuccessEvents(ctx, wallet, tx, ledgerEntry, correlationId, now);

            return {
              transactionId: tx.id,
              status: tx.status,
              balance: wallet.balance.toJSON(),
              idempotentReplay: false,
            };
          }

          case WagerTransactionKind.Rollback: {
            const refTx = await ctx.transactions.findReferenceTransaction(
              command.providerId,
              command.referenceExternalTransactionId!,
            );

            if (!refTx) {
              tx.markPendingReference();
              await ctx.transactions.save(tx);

              const pendingEvent = new WagerTransactionPendingReference({
                eventId: randomUUID(),
                aggregateId: tx.id,
                correlationId,
                occurredAt: now,
                data: {
                  transactionId: tx.id,
                  providerId: tx.providerId,
                  externalTransactionId: tx.externalTransactionId,
                  referenceExternalTransactionId: command.referenceExternalTransactionId!,
                  walletId: wallet.id,
                  playerId: wallet.playerId,
                  kind: tx.kind,
                },
              });
              await ctx.outbox.save(OutboxMessage.enqueue(pendingEvent));

              return {
                transactionId: tx.id,
                status: tx.status,
                balance: wallet.balance.toJSON(),
                idempotentReplay: false,
              };
            }

            if (
              refTx.kind !== WagerTransactionKind.Bet &&
              refTx.kind !== WagerTransactionKind.Win &&
              refTx.kind !== WagerTransactionKind.Refund
            ) {
              return this.rejectTx(
                ctx,
                tx,
                wallet,
                FailureCode.InvalidReferenceTransaction,
                correlationId,
                now,
              );
            }

            if (refTx.status !== WagerTransactionStatus.Processed) {
              return this.rejectTx(
                ctx,
                tx,
                wallet,
                FailureCode.InvalidTransactionState,
                correlationId,
                now,
              );
            }
            if (refTx.roundId !== tx.roundId) {
              return this.rejectTx(ctx, tx, wallet, FailureCode.RoundMismatch, correlationId, now);
            }
            if (!refTx.money.equals(money)) {
              return this.rejectTx(ctx, tx, wallet, FailureCode.AmountMismatch, correlationId, now);
            }

            // Inversão contábil do rollback
            const reversalDirection = tx.ledgerDirectionFor(refTx);

            if (reversalDirection === LedgerDirection.Debit) {
              if (wallet.balance.isLessThan(money)) {
                return this.rejectTx(
                  ctx,
                  tx,
                  wallet,
                  FailureCode.InsufficientFundsForReversal,
                  correlationId,
                  now,
                );
              }
            }

            const mutation =
              reversalDirection === LedgerDirection.Credit
                ? wallet.credit(money, now)
                : wallet.debit(money, now);

            tx.markProcessed(refTx.id, now);

            const ledgerEntry = WalletLedgerEntry.create({
              id: randomUUID(),
              walletId: wallet.id,
              transactionId: tx.id,
              direction: reversalDirection,
              money,
              balanceBefore: mutation.balanceBefore,
              balanceAfter: mutation.balanceAfter,
              createdAt: now,
            });

            await ctx.wallets.save(wallet);
            await ctx.transactions.save(tx);
            await ctx.ledgers.save(ledgerEntry);

            await this.publishSuccessEvents(ctx, wallet, tx, ledgerEntry, correlationId, now);

            return {
              transactionId: tx.id,
              status: tx.status,
              balance: wallet.balance.toJSON(),
              idempotentReplay: false,
            };
          }

          default:
            throw new UnprocessableEntityException(`Tipo de operação desconhecido: ${command.kind}`);
        }
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

  private async rejectTx(
    ctx: any,
    tx: WagerTransaction,
    wallet: any,
    code: FailureCode,
    correlationId: string,
    now: Date,
  ): Promise<ProcessWagerTransactionResult> {
    tx.reject(code, now);
    await ctx.transactions.save(tx);

    const rejectedEvent = new WagerTransactionRejected({
      eventId: randomUUID(),
      aggregateId: tx.id,
      correlationId,
      occurredAt: now,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        failureCode: code,
      },
    });
    await ctx.outbox.save(OutboxMessage.enqueue(rejectedEvent));

    return {
      transactionId: tx.id,
      status: tx.status,
      balance: wallet.balance.toJSON(),
      idempotentReplay: false,
      failureCode: code,
    };
  }

  private async publishSuccessEvents(
    ctx: any,
    wallet: any,
    tx: WagerTransaction,
    ledgerEntry: WalletLedgerEntry,
    correlationId: string,
    now: Date,
  ): Promise<void> {
    const balanceEvent = new WalletBalanceChanged({
      eventId: randomUUID(),
      aggregateId: wallet.id,
      correlationId,
      occurredAt: now,
      data: {
        walletId: wallet.id,
        transactionId: tx.id,
        direction: ledgerEntry.direction,
        money: ledgerEntry.money.toJSON(),
        balanceBefore: ledgerEntry.balanceBefore.toJSON(),
        balanceAfter: ledgerEntry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });

    const processedEvent = new WagerTransactionProcessed({
      eventId: randomUUID(),
      aggregateId: tx.id,
      correlationId,
      occurredAt: now,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        referenceTransactionId: tx.referenceTransactionId,
      },
    });

    await ctx.outbox.save(OutboxMessage.enqueue(balanceEvent));
    await ctx.outbox.save(OutboxMessage.enqueue(processedEvent));
  }
}
