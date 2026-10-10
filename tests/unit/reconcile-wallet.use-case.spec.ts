import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { ReconcileWalletUseCase } from '../../src/application/use-cases/reconcile-wallet.use-case.js';
import type { WalletRepositoryPort } from '../../src/application/ports/wallet.repository.port.js';
import type { WalletLedgerRepositoryPort } from '../../src/application/ports/wallet-ledger.repository.port.js';
import { Wallet } from '../../src/domain/wallet/wallet.aggregate.js';
import { Money } from '../../src/domain/shared/money.value-object.js';

describe('ReconcileWalletUseCase', () => {
  const walletId = 'wallet-1';
  const playerId = 'player-1';

  it('deve confirmar consistência quando o saldo armazenado bate exatamente com a soma do ledger', async () => {
    const mockWallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '75.00', currency: 'BRL' }),
    });

    const walletRepo: WalletRepositoryPort = {
      findById: async () => mockWallet,
      findByPlayerIdAndCurrency: async () => null,
      save: async () => {},
    };

    const ledgerRepo: WalletLedgerRepositoryPort = {
      save: async () => {},
      findByWalletId: async () => ({ entries: [] }),
      sumEntriesByWalletId: async () => ({
        totalCredits: '100.00',
        totalDebits: '25.00', // 100 - 25 = 75.00
        count: 2,
      }),
    };

    const useCase = new ReconcileWalletUseCase(walletRepo, ledgerRepo);
    const result = await useCase.execute(walletId);

    expect(result.consistent).toBe(true);
    expect(result.storedBalance.amount).toBe('75.00');
    expect(result.calculatedBalance.amount).toBe('75.00');
    expect(result.difference.amount).toBe('0.00');
    expect(result.checkedEntries).toBe(2);
  });

  it('deve detectar divergência quando o saldo armazenado diferir do ledger', async () => {
    const mockWallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '90.00', currency: 'BRL' }), // Saldo corrupto/divergente
    });

    const walletRepo: WalletRepositoryPort = {
      findById: async () => mockWallet,
      findByPlayerIdAndCurrency: async () => null,
      save: async () => {},
    };

    const ledgerRepo: WalletLedgerRepositoryPort = {
      save: async () => {},
      findByWalletId: async () => ({ entries: [] }),
      sumEntriesByWalletId: async () => ({
        totalCredits: '100.00',
        totalDebits: '25.00', // Calculado deveria ser 75.00
        count: 2,
      }),
    };

    const useCase = new ReconcileWalletUseCase(walletRepo, ledgerRepo);
    const result = await useCase.execute(walletId);

    expect(result.consistent).toBe(false);
    expect(result.storedBalance.amount).toBe('90.00');
    expect(result.calculatedBalance.amount).toBe('75.00');
    expect(result.difference.amount).toBe('15.00');
  });
});
