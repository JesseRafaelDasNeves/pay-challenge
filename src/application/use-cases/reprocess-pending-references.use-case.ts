import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  WAGER_TRANSACTION_REPOSITORY_PORT,
  type WagerTransactionRepositoryPort,
} from '../ports/wager-transaction.repository.port.js';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case.js';
import { UNIT_OF_WORK_PORT, type UnitOfWorkPort } from '../ports/unit-of-work.port.js';
import { FailureCode } from '../../domain/wagering/failure-code.enum.js';
import { WagerTransactionRejected } from '../../domain/messaging/integration-event.abstract.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.entity.js';

@Injectable()
export class ReprocessPendingReferencesUseCase {
  private readonly logger = new Logger(ReprocessPendingReferencesUseCase.name);

  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY_PORT)
    private readonly transactionRepository: WagerTransactionRepositoryPort,
    @Inject(UNIT_OF_WORK_PORT)
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
  ) {}

  public async execute(batchSize: number = 20): Promise<number> {
    const pendingList = await this.transactionRepository.findPendingReferences(batchSize);
    if (pendingList.length === 0) {
      return 0;
    }

    let processedCount = 0;
    const now = new Date();

    for (const pendingTx of pendingList) {
      if (!pendingTx.referenceExternalTransactionId) {
        continue;
      }

      // Verifica se a referência já está disponível no banco
      const ref = await this.transactionRepository.findReferenceTransaction(
        pendingTx.providerId,
        pendingTx.referenceExternalTransactionId,
      );

      if (ref && ref.status === 'PROCESSED') {
        // A referência chegou! Reprocessamos a transação
        try {
          await this.processWagerUseCase.execute({
            idempotencyKey: pendingTx.idempotencyKey,
            providerId: pendingTx.providerId,
            externalTransactionId: pendingTx.externalTransactionId,
            playerId: pendingTx.playerId,
            walletId: pendingTx.walletId,
            roundId: pendingTx.roundId,
            gameId: pendingTx.gameId,
            kind: pendingTx.kind,
            money: pendingTx.money.toJSON(),
            referenceExternalTransactionId: pendingTx.referenceExternalTransactionId,
            correlationId: randomUUID(),
          });
          processedCount++;
        } catch (error) {
          this.logger.error(
            `Falha ao reprocessar transação pendente de referência ${pendingTx.id}:`,
            error,
          );
        }
      } else {
        // Se a transação estiver em PENDING_REFERENCE há mais de 10 minutos (TTL configurado), rejeita
        const ageInMs = now.getTime() - pendingTx.createdAt.getTime();
        const maxTtlMs = 10 * 60 * 1000; // 10 minutos

        if (ageInMs > maxTtlMs) {
          await this.unitOfWork.executeInTransaction(async (ctx) => {
            const txToReject = await ctx.transactions.findById(pendingTx.id);
            if (txToReject && txToReject.status === 'PENDING_REFERENCE') {
              txToReject.reject(FailureCode.ReferenceNotFound, now);
              await ctx.transactions.save(txToReject);

              const rejectedEvent = new WagerTransactionRejected({
                eventId: randomUUID(),
                aggregateId: txToReject.id,
                correlationId: randomUUID(),
                occurredAt: now,
                data: {
                  transactionId: txToReject.id,
                  providerId: txToReject.providerId,
                  externalTransactionId: txToReject.externalTransactionId,
                  walletId: txToReject.walletId,
                  playerId: txToReject.playerId,
                  roundId: txToReject.roundId,
                  gameId: txToReject.gameId,
                  kind: txToReject.kind,
                  money: txToReject.money.toJSON(),
                  failureCode: FailureCode.ReferenceNotFound,
                },
              });
              await ctx.outbox.save(OutboxMessage.enqueue(rejectedEvent));
              processedCount++;
            }
          });
        }
      }
    }

    return processedCount;
  }
}
