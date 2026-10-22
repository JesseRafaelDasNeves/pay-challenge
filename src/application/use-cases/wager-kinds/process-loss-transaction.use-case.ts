import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  BaseWagerTransactionKindUseCase,
  type WagerTransactionKindExecutionParams,
} from './wager-transaction-kind.use-case.js';
import type { ProcessWagerTransactionResult } from '../process-wager-transaction.use-case.js';
import { WagerTransactionKind } from '../../../domain/wagering/wager-transaction-kind.enum.js';
import { OutboxMessage } from '../../../domain/messaging/outbox-message.entity.js';
import { WagerTransactionProcessed } from '../../../domain/messaging/integration-event.abstract.js';

@Injectable()
export class ProcessLossTransactionUseCase extends BaseWagerTransactionKindUseCase {
  public readonly kind = WagerTransactionKind.Loss;

  public async execute(
    params: WagerTransactionKindExecutionParams,
  ): Promise<ProcessWagerTransactionResult> {
    const { ctx, wallet, tx, money, correlationId, now } = params;

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
}

