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
import type { InboxRepositoryPort } from '../../src/application/ports/inbox.repository.port.js';
import type { OutboxRepositoryPort } from '../../src/application/ports/outbox.repository.port.js';
import { Wallet } from '../../src/domain/wallet/wallet.aggregate.js';
import { Money } from '../../src/domain/shared/money.value-object.js';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction.aggregate.js';
import { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger.entity.js';
import { InboxMessage } from '../../src/domain/messaging/inbox-message.entity.js';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message.entity.js';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status.enum.js';
import { FailureCode } from '../../src/domain/wagering/failure-code.enum.js';

// In-Memory Test Doubles
class InMemoryWalletRepository implements WalletRepositoryPort {
  public storage = new Map<string, Wallet>();

  public async findById(id: string): Promise<Wallet | null> {
    const found = this.storage.get(id);
    return found ? Wallet.rehydrate({
      id: found.id,
      playerId: found.playerId,
      currency: found.currency,
      balance: found.balance,
      version: found.version,
      createdAt: found.createdAt,
      updatedAt: found.updatedAt,
    }) : null;
  }

  public async findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    for (const w of this.storage.values()) {
      if (w.playerId === playerId && w.currency === currency) return w;
    }
    return null;
  }

  public async save(wallet: Wallet): Promise<void> {
    this.storage.set(wallet.id, wallet);
  }
}

class InMemoryLedgerRepository implements WalletLedgerRepositoryPort {
  public entries: WalletLedgerEntry[] = [];

  public async save(entry: WalletLedgerEntry): Promise<void> {
    this.entries.push(entry);
  }

  public async findByWalletId(walletId: string, limit: number): Promise<any> {
    const list = this.entries.filter((e) => e.walletId === walletId).slice(0, limit);
    return { entries: list };
  }

  public async sumEntriesByWalletId(walletId: string): Promise<any> {
    let credits = Money.zero('BRL');
    let debits = Money.zero('BRL');
    for (const e of this.entries.filter((x) => x.walletId === walletId)) {
      if (e.direction === 'CREDIT') credits = credits.add(e.money);
      if (e.direction === 'DEBIT') debits = debits.add(e.money);
    }
    return {
      totalCredits: credits.amount,
      totalDebits: debits.amount,
      count: this.entries.length,
    };
  }
}

class InMemoryTransactionRepository implements WagerTransactionRepositoryPort {
  public storage = new Map<string, WagerTransaction>();

  public async findById(id: string): Promise<WagerTransaction | null> {
    return this.storage.get(id) ?? null;
  }

  public async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    for (const tx of this.storage.values()) {
      if (tx.idempotencyKey === key) return tx;
    }
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

  public async save(transaction: WagerTransaction): Promise<void> {
    this.storage.set(transaction.id, transaction);
  }

  public async findPendingReferences(limit: number): Promise<WagerTransaction[]> {
    return Array.from(this.storage.values())
      .filter((t) => t.status === WagerTransactionStatus.PendingReference)
      .slice(0, limit);
  }
}

class InMemoryInboxRepository implements InboxRepositoryPort {
  public received = new Set<string>();

  public async exists(consumerName: string, messageId: string): Promise<boolean> {
    return this.received.has(`${consumerName}:${messageId}`);
  }

  public async save(message: InboxMessage): Promise<void> {
    this.received.add(`${message.consumerName}:${message.messageId}`);
  }
}

class InMemoryOutboxRepository implements OutboxRepositoryPort {
  public messages: OutboxMessage[] = [];

  public async save(message: OutboxMessage): Promise<void> {
    this.messages.push(message);
  }

  public async fetchDueMessages(): Promise<OutboxMessage[]> {
    return this.messages.filter((m) => m.isDue());
  }

  public async update(): Promise<void> {}
}

class InMemoryUnitOfWork implements UnitOfWorkPort {
  constructor(
    public readonly wallets: InMemoryWalletRepository,
    public readonly ledgers: InMemoryLedgerRepository,
    public readonly transactions: InMemoryTransactionRepository,
    public readonly inbox: InMemoryInboxRepository,
    public readonly outbox: InMemoryOutboxRepository,
  ) {}

  public async executeInTransaction<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    return work({
      wallets: this.wallets,
      ledgers: this.ledgers,
      transactions: this.transactions,
      inbox: this.inbox,
      outbox: this.outbox,
    });
  }
}

describe('ProcessWagerTransactionUseCase', () => {
  let walletsRepo: InMemoryWalletRepository;
  let ledgersRepo: InMemoryLedgerRepository;
  let txRepo: InMemoryTransactionRepository;
  let inboxRepo: InMemoryInboxRepository;
  let outboxRepo: InMemoryOutboxRepository;
  let uow: InMemoryUnitOfWork;
  let useCase: ProcessWagerTransactionUseCase;

  const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
  const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

  beforeEach(async () => {
    walletsRepo = new InMemoryWalletRepository();
    ledgersRepo = new InMemoryLedgerRepository();
    txRepo = new InMemoryTransactionRepository();
    inboxRepo = new InMemoryInboxRepository();
    outboxRepo = new InMemoryOutboxRepository();
    uow = new InMemoryUnitOfWork(walletsRepo, ledgersRepo, txRepo, inboxRepo, outboxRepo);
    useCase = new ProcessWagerTransactionUseCase(uow);

    // Inicializa wallet com saldo de 100.00 BRL
    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    await walletsRepo.save(wallet);
  });

  it('deve processar uma aposta BET com saldo suficiente: debita 25.00, gera ledger e outbox', async () => {
    const command: ProcessWagerTransactionCommand = {
      idempotencyKey: 'provider-a:tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'tx-1',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    };

    const result = await useCase.execute(command);

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('75.00');
    expect(result.idempotentReplay).toBe(false);

    // Verifica saldo da wallet
    const updatedWallet = await walletsRepo.findById(walletId);
    expect(updatedWallet?.balance.amount).toBe('75.00');
    expect(updatedWallet?.version).toBe(2);

    // Verifica lançamento no ledger
    expect(ledgersRepo.entries.length).toBe(1);
    expect(ledgersRepo.entries[0]?.direction).toBe('DEBIT');
    expect(ledgersRepo.entries[0]?.money.amount).toBe('25.00');

    // Verifica outbox de eventos
    expect(outboxRepo.messages.length).toBe(2); // WalletBalanceChanged + WagerTransactionProcessed
  });

  it('deve rejeitar uma aposta BET com saldo insuficiente: status REJECTED, sem alterar saldo ou ledger', async () => {
    const command: ProcessWagerTransactionCommand = {
      idempotencyKey: 'provider-a:tx-over',
      providerId: 'provider-a',
      externalTransactionId: 'tx-over',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '150.00', currency: 'BRL' }, // Saldo é 100.00
    };

    const result = await useCase.execute(command);

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.balance.amount).toBe('100.00');

    // Saldo da wallet inalterado
    const updatedWallet = await walletsRepo.findById(walletId);
    expect(updatedWallet?.balance.amount).toBe('100.00');
    expect(updatedWallet?.version).toBe(1);

    // Sem lançamentos no ledger
    expect(ledgersRepo.entries.length).toBe(0);

    // Evento WagerTransactionRejected enfileirado na outbox
    expect(outboxRepo.messages.length).toBe(1);
  });

  it('deve processar WIN creditando o valor no saldo e gerando ledger CREDIT', async () => {
    const command: ProcessWagerTransactionCommand = {
      idempotencyKey: 'provider-a:win-1',
      providerId: 'provider-a',
      externalTransactionId: 'win-1',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Win,
      money: { amount: '50.00', currency: 'BRL' },
    };

    const result = await useCase.execute(command);

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('150.00');
    expect(ledgersRepo.entries.length).toBe(1);
    expect(ledgersRepo.entries[0]?.direction).toBe('CREDIT');
  });

  it('deve processar LOSS marcando como PROCESSED sem alterar saldo nem ledger', async () => {
    const command: ProcessWagerTransactionCommand = {
      idempotencyKey: 'provider-a:loss-1',
      providerId: 'provider-a',
      externalTransactionId: 'loss-1',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Loss,
      money: { amount: '20.00', currency: 'BRL' },
    };

    const result = await useCase.execute(command);

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance.amount).toBe('100.00');
    expect(ledgersRepo.entries.length).toBe(0); // Nenhum lançamento
  });

  it('deve suportar idempotência idêntica retornando o mesmo resultado com idempotentReplay: true', async () => {
    const command: ProcessWagerTransactionCommand = {
      idempotencyKey: 'provider-a:tx-same',
      providerId: 'provider-a',
      externalTransactionId: 'tx-same',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '20.00', currency: 'BRL' },
    };

    const res1 = await useCase.execute(command);
    expect(res1.idempotentReplay).toBe(false);
    expect(res1.balance.amount).toBe('80.00');

    // Segunda chamada exatamente idêntica
    const res2 = await useCase.execute(command);
    expect(res2.idempotentReplay).toBe(true);
    expect(res2.transactionId).toBe(res1.transactionId);
    expect(res2.balance.amount).toBe('80.00');

    // Apenas 1 débito aplicado no ledger
    expect(ledgersRepo.entries.length).toBe(1);
  });

  it('deve rejeitar com 409 Conflict se a mesma idempotency key for enviada com payload divergente', async () => {
    const command1: ProcessWagerTransactionCommand = {
      idempotencyKey: 'provider-a:tx-conflict',
      providerId: 'provider-a',
      externalTransactionId: 'tx-conflict',
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '20.00', currency: 'BRL' },
    };

    await useCase.execute(command1);

    // Mesma key com valor diferente
    const command2 = {
      ...command1,
      money: { amount: '25.00', currency: 'BRL' },
    };

    expect(useCase.execute(command2)).rejects.toThrow();
  });
});
