import 'reflect-metadata';
import { describe, expect, it, beforeEach } from 'bun:test';
import { ProcessBetTransactionUseCase } from '../../src/application/use-cases/wager-kinds/process-bet-transaction.use-case.js';
import { ProcessWinTransactionUseCase } from '../../src/application/use-cases/wager-kinds/process-win-transaction.use-case.js';
import { ProcessLossTransactionUseCase } from '../../src/application/use-cases/wager-kinds/process-loss-transaction.use-case.js';
import { ProcessRefundTransactionUseCase } from '../../src/application/use-cases/wager-kinds/process-refund-transaction.use-case.js';
import { ProcessRollbackTransactionUseCase } from '../../src/application/use-cases/wager-kinds/process-rollback-transaction.use-case.js';
import type { TransactionalContext } from '../../src/application/ports/unit-of-work.port.js';
import { Wallet } from '../../src/domain/wallet/wallet.aggregate.js';
import { Money } from '../../src/domain/shared/money.value-object.js';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction.aggregate.js';
import type { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger.entity.js';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message.entity.js';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status.enum.js';
import { FailureCode } from '../../src/domain/wagering/failure-code.enum.js';

describe('WagerKindUseCases (Isolados)', () => {
  const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
  const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
  const now = new Date('2026-10-17T12:00:00.000Z');
  const correlationId = 'corr-123';

  let wallet: Wallet;
  let savedWallets: Wallet[];
  let savedTransactions: WagerTransaction[];
  let referenceMap: Map<string, WagerTransaction>;
  let savedLedgers: WalletLedgerEntry[];
  let savedOutbox: OutboxMessage[];
  let ctx: TransactionalContext;

  beforeEach(() => {
    wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      createdAt: now,
    });
    savedWallets = [];
    savedTransactions = [];
    referenceMap = new Map();
    savedLedgers = [];
    savedOutbox = [];

    ctx = {
      wallets: {
        findById: async () => wallet,
        findByPlayerIdAndCurrency: async () => wallet,
        save: async (w) => {
          savedWallets.push(w);
        },
      },
      ledgers: {
        save: async (entry) => {
          savedLedgers.push(entry);
        },
        findByWalletId: async () => ({ entries: [] }),
        sumEntriesByWalletId: async () => ({ totalCredits: '0.00', totalDebits: '0.00', count: 0 }),
      },
      transactions: {
        findById: async () => null,
        findByIdempotencyKey: async () => null,
        findByProviderAndExternalId: async (providerId, externalId) =>
          referenceMap.get(`${providerId}:${externalId}`) ?? null,
        findReferenceTransaction: async (providerId, refExternalId) =>
          referenceMap.get(`${providerId}:${refExternalId}`) ?? null,
        save: async (tx) => {
          savedTransactions.push(tx);
          referenceMap.set(`${tx.providerId}:${tx.externalTransactionId}`, tx);
        },
        findPendingReferences: async () => [],
      },
      inbox: {
        exists: async () => false,
        save: async () => {},
      },
      outbox: {
        save: async (msg) => {
          savedOutbox.push(msg);
        },
        fetchDueMessages: async () => [],
        update: async () => {},
      },
    };
  });

  function createPendingTx(
    kind: WagerTransactionKind,
    amount = '25.00',
    referenceExternalTransactionId?: string,
    roundId = 'round-1',
  ): WagerTransaction {
    return WagerTransaction.create({
      id: `tx-${kind.toLowerCase()}`,
      providerId: 'provider-a',
      externalTransactionId: `ext-${kind.toLowerCase()}`,
      idempotencyKey: `idem-${kind.toLowerCase()}`,
      payloadHash: 'hash-123',
      walletId,
      playerId,
      roundId,
      gameId: 'fortune-chimp',
      kind,
      money: Money.from({ amount, currency: 'BRL' }),
      referenceExternalTransactionId,
      createdAt: now,
    });
  }

  describe('ProcessBetTransactionUseCase', () => {
    const betUseCase = new ProcessBetTransactionUseCase();

    it('deve debitar a carteira, gerar ledger DEBIT e publicar 2 eventos no Outbox', async () => {
      const tx = createPendingTx(WagerTransactionKind.Bet, '30.00');
      const result = await betUseCase.execute({
        ctx,
        wallet,
        tx,
        money: tx.money,
        correlationId,
        now,
      });

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe('70.00');
      expect(savedWallets.length).toBe(1);
      expect(savedLedgers.length).toBe(1);
      expect(savedLedgers[0]?.direction).toBe('DEBIT');
      expect(savedOutbox.length).toBe(2);
    });

    it('deve rejeitar com INSUFFICIENT_FUNDS quando saldo for menor que a aposta', async () => {
      const tx = createPendingTx(WagerTransactionKind.Bet, '120.00');
      const result = await betUseCase.execute({
        ctx,
        wallet,
        tx,
        money: tx.money,
        correlationId,
        now,
      });

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(result.balance.amount).toBe('100.00');
      expect(savedLedgers.length).toBe(0);
      expect(savedOutbox.length).toBe(1);
    });
  });

  describe('ProcessWinTransactionUseCase', () => {
    const winUseCase = new ProcessWinTransactionUseCase();

    it('deve creditar a carteira, gerar ledger CREDIT e publicar 2 eventos no Outbox', async () => {
      const tx = createPendingTx(WagerTransactionKind.Win, '45.00');
      const result = await winUseCase.execute({
        ctx,
        wallet,
        tx,
        money: tx.money,
        correlationId,
        now,
      });

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe('145.00');
      expect(savedLedgers.length).toBe(1);
      expect(savedLedgers[0]?.direction).toBe('CREDIT');
      expect(savedOutbox.length).toBe(2);
    });
  });

  describe('ProcessLossTransactionUseCase', () => {
    const lossUseCase = new ProcessLossTransactionUseCase();

    it('deve marcar transação como PROCESSED sem alterar carteira ou ledger', async () => {
      const tx = createPendingTx(WagerTransactionKind.Loss, '10.00');
      const result = await lossUseCase.execute({
        ctx,
        wallet,
        tx,
        money: tx.money,
        correlationId,
        now,
      });

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance.amount).toBe('100.00');
      expect(savedWallets.length).toBe(0);
      expect(savedLedgers.length).toBe(0);
      expect(savedOutbox.length).toBe(1);
    });
  });

  describe('ProcessRefundTransactionUseCase', () => {
    const refundUseCase = new ProcessRefundTransactionUseCase();

    it('deve rejeitar com INVALID_REFERENCE_TRANSACTION se a referência não for BET', async () => {
      const refWin = createPendingTx(WagerTransactionKind.Win, '25.00');
      refWin.markProcessed(undefined, now);
      referenceMap.set(`${refWin.providerId}:${refWin.externalTransactionId}`, refWin);

      const refundTx = createPendingTx(
        WagerTransactionKind.Refund,
        '25.00',
        refWin.externalTransactionId,
      );
      const result = await refundUseCase.execute({
        ctx,
        wallet,
        tx: refundTx,
        money: refundTx.money,
        correlationId,
        now,
      });

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.InvalidReferenceTransaction);
    });

    it('deve rejeitar com ROUND_MISMATCH se roundId divergir da BET original', async () => {
      const refBet = createPendingTx(WagerTransactionKind.Bet, '25.00', undefined, 'round-1');
      refBet.markProcessed(undefined, now);
      referenceMap.set(`${refBet.providerId}:${refBet.externalTransactionId}`, refBet);

      const refundTx = createPendingTx(
        WagerTransactionKind.Refund,
        '25.00',
        refBet.externalTransactionId,
        'round-divergente',
      );
      const result = await refundUseCase.execute({
        ctx,
        wallet,
        tx: refundTx,
        money: refundTx.money,
        correlationId,
        now,
      });

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.RoundMismatch);
    });
  });

  describe('ProcessRollbackTransactionUseCase', () => {
    const rollbackUseCase = new ProcessRollbackTransactionUseCase();

    it('deve marcar como PENDING_REFERENCE se a referência ainda não existir', async () => {
      const rollbackTx = createPendingTx(
        WagerTransactionKind.Rollback,
        '25.00',
        'ext-missing',
      );

      const result = await rollbackUseCase.execute({
        ctx,
        wallet,
        tx: rollbackTx,
        money: rollbackTx.money,
        correlationId,
        now,
      });

      expect(result.status).toBe(WagerTransactionStatus.PendingReference);
      expect(savedOutbox.length).toBe(1);
    });

    it('deve rejeitar com INVALID_REFERENCE_TRANSACTION ao tentar fazer ROLLBACK de LOSS', async () => {
      const refLoss = createPendingTx(WagerTransactionKind.Loss, '25.00');
      refLoss.markProcessed(undefined, now);
      referenceMap.set(`${refLoss.providerId}:${refLoss.externalTransactionId}`, refLoss);

      const rollbackTx = createPendingTx(
        WagerTransactionKind.Rollback,
        '25.00',
        refLoss.externalTransactionId,
      );

      const result = await rollbackUseCase.execute({
        ctx,
        wallet,
        tx: rollbackTx,
        money: rollbackTx.money,
        correlationId,
        now,
      });

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe(FailureCode.InvalidReferenceTransaction);
    });
  });
});

