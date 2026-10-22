import 'reflect-metadata';
import { describe, expect, it, beforeEach } from 'bun:test';
import {
  ProcessWagerTransactionUseCase,
  type ProcessWagerTransactionCommand,
} from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import type { UnitOfWorkPort, TransactionalContext } from '../../src/application/ports/unit-of-work.port.js';
import type { WalletRepositoryPort } from '../../src/application/ports/wallet.repository.port.js';
import type { WalletLedgerRepositoryPort } from '../../src/application/ports/wallet-ledger.repository.port.js';
import type { WagerTransactionRepositoryPort } from '../../src/application/ports/wager-transaction.repository.port.js';
import { Wallet } from '../../src/domain/wallet/wallet.aggregate.js';
import { Money } from '../../src/domain/shared/money.value-object.js';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction.aggregate.js';
import { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger.entity.js';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.enum.js';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status.enum.js';
import { FailureCode } from '../../src/domain/wagering/failure-code.enum.js';
import { ProcessBetTransactionUseCase } from '../../src/application/use-cases/wager-kinds/process-bet-transaction.use-case.js';
import { ProcessWinTransactionUseCase } from '../../src/application/use-cases/wager-kinds/process-win-transaction.use-case.js';
import { ProcessLossTransactionUseCase } from '../../src/application/use-cases/wager-kinds/process-loss-transaction.use-case.js';
import { ProcessRefundTransactionUseCase } from '../../src/application/use-cases/wager-kinds/process-refund-transaction.use-case.js';
import { ProcessRollbackTransactionUseCase } from '../../src/application/use-cases/wager-kinds/process-rollback-transaction.use-case.js';

class MockWalletRepository implements WalletRepositoryPort {
  public storage = new Map<string, Wallet>();
  public async findById(id: string): Promise<Wallet | null> {
    const f = this.storage.get(id);
    return f
      ? Wallet.rehydrate({
          id: f.id,
          playerId: f.playerId,
          currency: f.currency,
          balance: f.balance,
          version: f.version,
          createdAt: f.createdAt,
          updatedAt: f.updatedAt,
        })
      : null;
  }
  public async findByPlayerIdAndCurrency(): Promise<Wallet | null> { return null; }
  public async save(wallet: Wallet): Promise<void> { this.storage.set(wallet.id, wallet); }
}

class MockLedgerRepository implements WalletLedgerRepositoryPort {
  public entries: WalletLedgerEntry[] = [];
  public async save(entry: WalletLedgerEntry): Promise<void> { this.entries.push(entry); }
  public async findByWalletId(): Promise<any> { return { entries: [] }; }
  public async sumEntriesByWalletId(): Promise<any> { return { totalCredits: '0.00', totalDebits: '0.00', count: 0 }; }
}

class MockTransactionRepository implements WagerTransactionRepositoryPort {
  public storage = new Map<string, WagerTransaction>();
  public async findById(id: string): Promise<WagerTransaction | null> { return this.storage.get(id) ?? null; }
  public async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    for (const tx of this.storage.values()) if (tx.idempotencyKey === key) return tx;
    return null;
  }
  public async findByProviderAndExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null> {
    for (const tx of this.storage.values()) {
      if (tx.providerId === providerId && tx.externalTransactionId === externalId) return tx;
    }
    return null;
  }
  public async findReferenceTransaction(providerId: string, referenceExternalId: string): Promise<WagerTransaction | null> {
    return this.findByProviderAndExternalId(providerId, referenceExternalId);
  }
  public async save(transaction: WagerTransaction): Promise<void> { this.storage.set(transaction.id, transaction); }
  public async findPendingReferences(): Promise<WagerTransaction[]> { return []; }
}

class MockUnitOfWork implements UnitOfWorkPort {
  constructor(
    public readonly wallets: MockWalletRepository,
    public readonly ledgers: MockLedgerRepository,
    public readonly transactions: MockTransactionRepository,
  ) {}
  public async executeInTransaction<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    return work({
      wallets: this.wallets,
      ledgers: this.ledgers,
      transactions: this.transactions,
      inbox: { exists: async () => false, save: async () => {} },
      outbox: { save: async () => {}, fetchDueMessages: async () => [], update: async () => {} },
    });
  }
}

describe('Reversões (REFUND e ROLLBACK) e Referências Fora de Ordem', () => {
  let walletsRepo: MockWalletRepository;
  let ledgersRepo: MockLedgerRepository;
  let txRepo: MockTransactionRepository;
  let useCase: ProcessWagerTransactionUseCase;

  const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
  const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

  beforeEach(async () => {
    walletsRepo = new MockWalletRepository();
    ledgersRepo = new MockLedgerRepository();
    txRepo = new MockTransactionRepository();
    const uow = new MockUnitOfWork(walletsRepo, ledgersRepo, txRepo);
    useCase = new ProcessWagerTransactionUseCase(
      uow,
      new ProcessBetTransactionUseCase(),
      new ProcessWinTransactionUseCase(),
      new ProcessLossTransactionUseCase(),
      new ProcessRefundTransactionUseCase(),
      new ProcessRollbackTransactionUseCase(),
    );

    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    await walletsRepo.save(wallet);
  });

  it('deve marcar REFUND como PENDING_REFERENCE se a aposta original ainda não chegou', async () => {
    const refundCommand: ProcessWagerTransactionCommand = {
      idempotencyKey: 'provider-a:ref-out-of-order',
      providerId: 'provider-a',
      externalTransactionId: 'ref-out-of-order',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-not-yet-arrived',
    };

    const result = await useCase.execute(refundCommand);

    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    // Saldo inalterado enquanto aguarda
    expect(result.balance.amount).toBe('100.00');
    expect(ledgersRepo.entries.length).toBe(0);
  });

  it('deve processar REFUND com sucesso quando a BET referenciada existir', async () => {
    // 1. Processa a BET
    await useCase.execute({
      idempotencyKey: 'provider-a:bet-initial',
      providerId: 'provider-a',
      externalTransactionId: 'bet-initial',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    });

    // Saldo atual = 75.00
    // 2. Executa REFUND
    const refundRes = await useCase.execute({
      idempotencyKey: 'provider-a:refund-bet',
      providerId: 'provider-a',
      externalTransactionId: 'refund-bet',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-initial',
    });

    expect(refundRes.status).toBe(WagerTransactionStatus.Processed);
    expect(refundRes.balance.amount).toBe('100.00'); // Estorno devolveu 25.00
    expect(ledgersRepo.entries.length).toBe(2); // 1 DEBIT + 1 CREDIT
    expect(ledgersRepo.entries[1]?.direction).toBe(LedgerDirection.Credit);
  });

  it('deve rejeitar REFUND se o valor diferir do valor da aposta referenciada', async () => {
    // 1. Processa a BET de 25.00
    await useCase.execute({
      idempotencyKey: 'provider-a:bet-orig',
      providerId: 'provider-a',
      externalTransactionId: 'bet-orig',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    });

    // 2. Tenta REFUND de 30.00
    const refundRes = await useCase.execute({
      idempotencyKey: 'provider-a:refund-wrong-amount',
      providerId: 'provider-a',
      externalTransactionId: 'refund-wrong-amount',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-orig',
    });

    expect(refundRes.status).toBe(WagerTransactionStatus.Rejected);
    expect(refundRes.failureCode).toBe(FailureCode.AmountMismatch);
  });

  it('deve processar ROLLBACK de uma operação de WIN invertendo para débito', async () => {
    // 1. Ganho de 50.00 -> saldo vai para 150.00
    await useCase.execute({
      idempotencyKey: 'provider-a:win-to-rollback',
      providerId: 'provider-a',
      externalTransactionId: 'win-to-rollback',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Win,
      money: { amount: '50.00', currency: 'BRL' },
    });

    // 2. Rollback do WIN -> debita 50.00 -> saldo volta para 100.00
    const rollbackRes = await useCase.execute({
      idempotencyKey: 'provider-a:rollback-win',
      providerId: 'provider-a',
      externalTransactionId: 'rollback-win',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: 'win-to-rollback',
    });

    expect(rollbackRes.status).toBe(WagerTransactionStatus.Processed);
    expect(rollbackRes.balance.amount).toBe('100.00');
    expect(ledgersRepo.entries.length).toBe(2);
    expect(ledgersRepo.entries[1]?.direction).toBe(LedgerDirection.Debit);
  });

  it('deve rejeitar ROLLBACK que produziria saldo negativo com código INSUFFICIENT_FUNDS_FOR_REVERSAL', async () => {
    // Carteira começa com 100.00. Suponha que houve um WIN de 80.00 (saldo foi a 180.00),
    // mas o jogador depois apostou 150.00 (saldo ficou em 30.00).
    // Se o provedor tentar fazer ROLLBACK do WIN de 80.00, faltará saldo!
    const wallet = await walletsRepo.findById(walletId);
    wallet?.debit(Money.from({ amount: '80.00', currency: 'BRL' })); // saldo fica 20.00
    await walletsRepo.save(wallet!);

    // Cria WIN de 50.00 no histórico
    const winTx = WagerTransaction.create({
      id: 'tx-win-id',
      providerId: 'provider-a',
      externalTransactionId: 'win-tx-huge',
      idempotencyKey: 'key-win-huge',
      payloadHash: 'hash',
      walletId,
      playerId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
    });
    winTx.markProcessed(undefined, new Date());
    await txRepo.save(winTx);

    // Saldo atual é 20.00. Tenta reverter WIN de 50.00:
    const rollbackRes = await useCase.execute({
      idempotencyKey: 'provider-a:rollback-overdraft',
      providerId: 'provider-a',
      externalTransactionId: 'rollback-overdraft',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: 'win-tx-huge',
    });

    expect(rollbackRes.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollbackRes.failureCode).toBe(FailureCode.InsufficientFundsForReversal);
    expect(rollbackRes.balance.amount).toBe('20.00'); // Saldo protegido contra negatividade
  });
});
