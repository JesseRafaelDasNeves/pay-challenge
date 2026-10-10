import { describe, expect, it } from 'bun:test';
import { Wallet } from '../../src/domain/wallet/wallet.aggregate.js';
import { Money } from '../../src/domain/shared/money.value-object.js';

describe('Wallet Aggregate', () => {
  it('deve abrir uma carteira com saldo inicial e version = 1', () => {
    const initialBalance = Money.from({ amount: '100.00', currency: 'BRL' });
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance,
    });

    expect(wallet.id).toBe('wallet-1');
    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('deve aplicar crédito com sucesso e incrementar version', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    const creditAmount = Money.from({ amount: '25.00', currency: 'BRL' });
    const result = wallet.credit(creditAmount);

    expect(result.balanceBefore.amount).toBe('50.00');
    expect(result.balanceAfter.amount).toBe('75.00');
    expect(wallet.balance.amount).toBe('75.00');
    expect(wallet.version).toBe(2);
  });

  it('deve aplicar débito com sucesso e incrementar version', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const debitAmount = Money.from({ amount: '30.00', currency: 'BRL' });
    const result = wallet.debit(debitAmount);

    expect(result.balanceBefore.amount).toBe('100.00');
    expect(result.balanceAfter.amount).toBe('70.00');
    expect(wallet.balance.amount).toBe('70.00');
    expect(wallet.version).toBe(2);
  });

  it('deve lançar erro ao tentar debitar valor maior que o saldo (saldo nunca negativo)', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    const excessiveDebit = Money.from({ amount: '60.00', currency: 'BRL' });
    expect(() => wallet.debit(excessiveDebit)).toThrow('Saldo insuficiente para realizar o débito.');
    // Saldo e version não devem sofrer mutação
    expect(wallet.balance.amount).toBe('50.00');
    expect(wallet.version).toBe(1);
  });

  it('deve lançar erro em operações com moedas divergentes', () => {
    const wallet = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    const usd = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => wallet.credit(usd)).toThrow('Incompatibilidade de moedas');
    expect(() => wallet.debit(usd)).toThrow('Incompatibilidade de moedas');
  });
});
