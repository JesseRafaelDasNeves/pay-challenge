import { randomUUID } from 'node:crypto';
import type { TransactionalContext } from '../../ports/unit-of-work.port.js';
import type { ProcessWagerTransactionResult } from '../process-wager-transaction.use-case.js';
import type { Wallet, BalanceMutationResult } from '../../../domain/wallet/wallet.aggregate.js';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction.aggregate.js';
import type { Money } from '../../../domain/shared/money.value-object.js';
import type { WagerTransactionKind } from '../../../domain/wagering/wager-transaction-kind.enum.js';
import type { FailureCode } from '../../../domain/wagering/failure-code.enum.js';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger.entity.js';
import type { LedgerDirection } from '../../../domain/wallet/ledger-direction.enum.js';
import { OutboxMessage } from '../../../domain/messaging/outbox-message.entity.js';
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../../domain/messaging/integration-event.abstract.js';

export interface WagerTransactionKindExecutionParams {
  ctx: TransactionalContext;
  wallet: Wallet;
  tx: WagerTransaction;
  money: Money;
  correlationId: string;
  now: Date;
}

export interface WagerTransactionKindUseCase {
  readonly kind: WagerTransactionKind;
  execute(params: WagerTransactionKindExecutionParams): Promise<ProcessWagerTransactionResult>;
}

export abstract class BaseWagerTransactionKindUseCase implements WagerTransactionKindUseCase {
  public abstract readonly kind: WagerTransactionKind;

  public abstract execute(
    params: WagerTransactionKindExecutionParams,
  ): Promise<ProcessWagerTransactionResult>;

  protected async applyBalanceMutationAndPublish(
    params: WagerTransactionKindExecutionParams,
    direction: LedgerDirection,
    mutation: BalanceMutationResult,
  ): Promise<ProcessWagerTransactionResult> {
    const { ctx, wallet, tx, money, correlationId, now } = params;

    const ledgerEntry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: tx.id,
      direction,
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

  protected async rejectTransaction(
    params: WagerTransactionKindExecutionParams,
    code: FailureCode,
  ): Promise<ProcessWagerTransactionResult> {
    const { ctx, wallet, tx, correlationId, now } = params;

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

  protected async markPendingReferenceAndPublish(
    params: WagerTransactionKindExecutionParams,
    referenceExternalTransactionId: string,
  ): Promise<ProcessWagerTransactionResult> {
    const { ctx, wallet, tx, correlationId, now } = params;

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
        referenceExternalTransactionId,
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

  protected async publishSuccessEvents(
    ctx: TransactionalContext,
    wallet: Wallet,
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

