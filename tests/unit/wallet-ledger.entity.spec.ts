import { describe, expect, it } from 'bun:test';
import { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger.entity.js';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.enum.js';
import { Money } from '../../src/domain/shared/money.value-object.js';

describe('WalletLedgerEntry Entity', () => {
  it('deve criar lançamento de crédito válido satisfazendo balanceBefore + amount === balanceAfter', () => {
    const entry = WalletLedgerEntry.create({
      id: 'ledger-1',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Credit,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '150.00', currency: 'BRL' }),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.money.amount).toBe('50.00');
  });

  it('deve criar lançamento de débito válido satisfazendo balanceBefore - amount === balanceAfter', () => {
    const entry = WalletLedgerEntry.create({
      id: 'ledger-2',
      walletId: 'wallet-1',
      transactionId: 'tx-2',
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '30.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '70.00', currency: 'BRL' }),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
  });

  it('deve lançar erro se a equação contábil aritmética for violada', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-3',
        walletId: 'wallet-1',
        transactionId: 'tx-3',
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '30.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '75.00', currency: 'BRL' }), // Incorreto: deveria ser 70.00
      }),
    ).toThrow('Inconsistência contábil no ledger');
  });

  it('deve rejeitar lançamentos com valores monetários zero ou negativos', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'ledger-4',
        walletId: 'wallet-1',
        transactionId: 'tx-4',
        direction: LedgerDirection.Credit,
        money: Money.zero('BRL'),
        balanceBefore: Money.from({ amount: '10.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '10.00', currency: 'BRL' }),
      }),
    ).toThrow('O valor do lançamento no ledger deve ser estritamente positivo.');
  });
});
