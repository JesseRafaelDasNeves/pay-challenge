import 'reflect-metadata';
import { describe, expect, it, beforeEach } from 'bun:test';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case.js';
import { GetWalletUseCase } from '../../src/application/use-cases/get-wallet.use-case.js';
import type { WalletRepositoryPort } from '../../src/application/ports/wallet.repository.port.js';
import type { UnitOfWorkPort, TransactionalContext } from '../../src/application/ports/unit-of-work.port.js';
import { Wallet } from '../../src/domain/wallet/wallet.aggregate.js';
import { Money } from '../../src/domain/shared/money.value-object.js';
import { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger.entity.js';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction.aggregate.js';

class MockWalletRepo implements WalletRepositoryPort {
  public storage = new Map<string, Wallet>();
  public async findById(id: string): Promise<Wallet | null> {
    return this.storage.get(id) ?? null;
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

class MockUow implements UnitOfWorkPort {
  public ledgerEntries: WalletLedgerEntry[] = [];
  public transactions: WagerTransaction[] = [];
  public outboxMessages: any[] = [];

  constructor(public readonly walletRepo: MockWalletRepo) {}

  public async executeInTransaction<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T> {
    return work({
      wallets: this.walletRepo,
      ledgers: {
        save: async (entry) => { this.ledgerEntries.push(entry); },
        findByWalletId: async () => ({ entries: [] }),
        sumEntriesByWalletId: async () => ({ totalCredits: '0.00', totalDebits: '0.00', count: 0 }),
      },
      transactions: {
        save: async (tx) => { this.transactions.push(tx); },
        findById: async () => null,
        findByIdempotencyKey: async () => null,
        findByProviderAndExternalId: async () => null,
        findReferenceTransaction: async () => null,
        findPendingReferences: async () => [],
      },
      inbox: { exists: async () => false, save: async () => {} },
      outbox: {
        save: async (msg) => { this.outboxMessages.push(msg); },
        fetchDueMessages: async () => [],
        update: async () => {},
      },
    });
  }
}

describe('Wallet Use Cases (CreateWallet & GetWallet)', () => {
  let walletRepo: MockWalletRepo;
  let uow: MockUow;
  let createUseCase: CreateWalletUseCase;
  let getUseCase: GetWalletUseCase;

  beforeEach(() => {
    walletRepo = new MockWalletRepo();
    uow = new MockUow(walletRepo);
    createUseCase = new CreateWalletUseCase(uow, walletRepo);
    getUseCase = new GetWalletUseCase(walletRepo);
  });

  it('deve criar uma carteira com saldo inicial > 0, gerando transação OPENING e ledger CREDIT', async () => {
    const result = await createUseCase.execute({
      playerId: 'player-1',
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    expect(result.id).toBeDefined();
    expect(result.playerId).toBe('player-1');
    expect(result.balance.amount).toBe('1000.00');
    expect(result.version).toBe(1);

    // Verifica persistência da carteira
    const saved = await walletRepo.findById(result.id);
    expect(saved).toBeDefined();
    expect(saved?.balance.amount).toBe('1000.00');

    // Verifica que gerou transação OPENING interna
    expect(uow.transactions.length).toBe(1);
    expect(uow.transactions[0]?.kind).toBe('OPENING');
    expect(uow.transactions[0]?.status).toBe('PROCESSED');

    // Verifica que gerou ledger correspondente
    expect(uow.ledgerEntries.length).toBe(1);
    expect(uow.ledgerEntries[0]?.direction).toBe('CREDIT');
    expect(uow.ledgerEntries[0]?.money.amount).toBe('1000.00');
    expect(uow.ledgerEntries[0]?.balanceAfter.amount).toBe('1000.00');
  });

  it('deve criar uma carteira com saldo inicial zero sem gerar transação OPENING', async () => {
    const result = await createUseCase.execute({
      playerId: 'player-2',
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });

    expect(result.balance.amount).toBe('0.00');
    expect(uow.transactions.length).toBe(0);
    expect(uow.ledgerEntries.length).toBe(0);
  });

  it('deve rejeitar criação de carteira duplicada para o mesmo playerId + currency com 409 Conflict', async () => {
    await createUseCase.execute({
      playerId: 'player-dupe',
      initialBalance: { amount: '50.00', currency: 'BRL' },
    });

    expect(
      createUseCase.execute({
        playerId: 'player-dupe',
        initialBalance: { amount: '10.00', currency: 'BRL' },
      }),
    ).rejects.toThrow();
  });

  it('deve consultar carteira existente via GetWalletUseCase', async () => {
    const created = await createUseCase.execute({
      playerId: 'player-get',
      initialBalance: { amount: '250.00', currency: 'BRL' },
    });

    const queried = await getUseCase.execute(created.id);
    expect(queried.id).toBe(created.id);
    expect(queried.playerId).toBe('player-get');
    expect(queried.balance.amount).toBe('250.00');
  });

  it('deve lançar NotFoundException ao buscar carteira inexistente', async () => {
    expect(getUseCase.execute('nao-existe')).rejects.toThrow('não encontrada');
  });
});
