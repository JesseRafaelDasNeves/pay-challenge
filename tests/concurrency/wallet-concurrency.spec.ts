import 'reflect-metadata';
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AppDataSource } from '../../src/infrastructure/persistence/data-source.js';
import { TypeOrmUnitOfWork } from '../../src/infrastructure/persistence/repositories/typeorm-unit-of-work.js';
import { ProcessWagerTransactionUseCase } from '../../src/application/use-cases/process-wager-transaction.use-case.js';
import { CreateWalletUseCase } from '../../src/application/use-cases/create-wallet.use-case.js';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case.js';
import { TypeOrmWalletRepository } from '../../src/infrastructure/persistence/repositories/typeorm-wallet.repository.js';
import { TypeOrmWalletLedgerRepository } from '../../src/infrastructure/persistence/repositories/typeorm-wallet-ledger.repository.js';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status.enum.js';
import { FailureCode } from '../../src/domain/wagering/failure-code.enum.js';
import { ProcessBetTransactionUseCase } from '../../src/application/use-cases/wager-kinds/process-bet-transaction.use-case.js';
import { ProcessWinTransactionUseCase } from '../../src/application/use-cases/wager-kinds/process-win-transaction.use-case.js';
import { ProcessLossTransactionUseCase } from '../../src/application/use-cases/wager-kinds/process-loss-transaction.use-case.js';
import { ProcessRefundTransactionUseCase } from '../../src/application/use-cases/wager-kinds/process-refund-transaction.use-case.js';
import { ProcessRollbackTransactionUseCase } from '../../src/application/use-cases/wager-kinds/process-rollback-transaction.use-case.js';

describe('Testes de Concorrência Real no PostgreSQL', () => {
  let uow: TypeOrmUnitOfWork;
  let processWagerUseCase: ProcessWagerTransactionUseCase;
  let createWalletUseCase: CreateWalletUseCase;
  let reconcileWalletUseCase: ReconcileWalletUseCase;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }
    uow = new TypeOrmUnitOfWork(AppDataSource);
    const walletRepo = new TypeOrmWalletRepository(AppDataSource.manager);
    const ledgerRepo = new TypeOrmWalletLedgerRepository(AppDataSource.manager);

    processWagerUseCase = new ProcessWagerTransactionUseCase(
      uow,
      new ProcessBetTransactionUseCase(),
      new ProcessWinTransactionUseCase(),
      new ProcessLossTransactionUseCase(),
      new ProcessRefundTransactionUseCase(),
      new ProcessRollbackTransactionUseCase(),
    );
    createWalletUseCase = new CreateWalletUseCase(uow, walletRepo);
    reconcileWalletUseCase = new ReconcileWalletUseCase(walletRepo, ledgerRepo);
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  });

  it('Cenário Obrigatório: duas apostas de 80.00 disputando saldo de 100.00 simultaneamente', async () => {
    const playerId = randomUUID();
    // 1. Cria wallet com saldo inicial de 100.00 BRL
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const bet1 = {
      idempotencyKey: `prov-1:${randomUUID()}`,
      providerId: 'prov-1',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    };

    const bet2 = {
      idempotencyKey: `prov-1:${randomUUID()}`,
      providerId: 'prov-1',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: 'round-2',
      gameId: 'game-1',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    };

    // Executa as duas apostas em paralelo absoluto no Node/Bun contra o PostgreSQL
    const [res1, res2] = await Promise.all([
      processWagerUseCase.execute(bet1),
      processWagerUseCase.execute(bet2),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // Exatamente uma PROCESSED e uma REJECTED
    expect(statuses).toEqual([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected]);

    const rejected = res1.status === WagerTransactionStatus.Rejected ? res1 : res2;
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);

    // Saldo final deve ser exatamente 20.00 BRL
    const reconciliation = await reconcileWalletUseCase.execute(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('20.00');
    expect(reconciliation.calculatedBalance.amount).toBe('20.00');
    expect(reconciliation.difference.amount).toBe('0.00');
  });

  it('Cenário de Idempotência Concorrente: mesma aposta submetida 50 vezes em paralelo', async () => {
    const playerId = randomUUID();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const fixedKey = `provider-conc:${randomUUID()}`;
    const fixedExtId = randomUUID();

    const command = {
      idempotencyKey: fixedKey,
      providerId: 'provider-conc',
      externalTransactionId: fixedExtId,
      playerId,
      walletId: wallet.id,
      roundId: 'round-conc',
      gameId: 'game-conc',
      kind: WagerTransactionKind.Bet,
      money: { amount: '35.00', currency: 'BRL' },
    };

    // Dispara 50 requisições simultâneas
    const promises = Array.from({ length: 50 }, () => processWagerUseCase.execute(command));
    const results = await Promise.all(promises);

    // Todas as 50 respostas devem ter status PROCESSED
    for (const r of results) {
      expect(r.status).toBe(WagerTransactionStatus.Processed);
    }

    // Exatamente uma aposta foi a primeira (idempotentReplay: false) e as outras 49 foram replay (idempotentReplay: true)
    const newExecutions = results.filter((r) => !r.idempotentReplay);
    const replays = results.filter((r) => r.idempotentReplay);

    expect(newExecutions.length).toBe(1);
    expect(replays.length).toBe(49);

    // Saldo final deve ser 100 - 35 = 65.00 BRL (apenas um débito aplicado!)
    const reconciliation = await reconcileWalletUseCase.execute(wallet.id);
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.storedBalance.amount).toBe('65.00');
    expect(reconciliation.calculatedBalance.amount).toBe('65.00');
    expect(reconciliation.difference.amount).toBe('0.00');
  });
});
