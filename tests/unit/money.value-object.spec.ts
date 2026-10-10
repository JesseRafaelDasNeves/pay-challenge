import { describe, expect, it } from 'bun:test';
import { Money } from '../../src/domain/shared/money.value-object.js';

describe('Money Value Object', () => {
  it('deve instanciar um Money válido com 2 casas decimais', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(money.amount).toBe('25.00');
    expect(money.currency).toBe('BRL');
    expect(money.isPositive()).toBe(true);
    expect(money.isZero()).toBe(false);
  });

  it('deve formatar zero corretamente', () => {
    const zero = Money.zero('BRL');
    expect(zero.amount).toBe('0.00');
    expect(zero.isZero()).toBe(true);
  });

  it('deve somar valores monetários com exatidão decimal sem erros de float', () => {
    const m1 = Money.from({ amount: '0.10', currency: 'BRL' });
    const m2 = Money.from({ amount: '0.20', currency: 'BRL' });
    const sum = m1.add(m2);

    expect(sum.amount).toBe('0.30'); // No JS puro 0.1 + 0.2 = 0.30000000000000004
  });

  it('deve subtrair valores monetários com exatidão', () => {
    const m1 = Money.from({ amount: '100.00', currency: 'BRL' });
    const m2 = Money.from({ amount: '25.50', currency: 'BRL' });
    const diff = m1.subtract(m2);

    expect(diff.amount).toBe('74.50');
  });

  it('deve comparar igualdade e magnitude', () => {
    const m1 = Money.from({ amount: '50.00', currency: 'BRL' });
    const m2 = Money.from({ amount: '50.00', currency: 'BRL' });
    const m3 = Money.from({ amount: '100.00', currency: 'BRL' });

    expect(m1.equals(m2)).toBe(true);
    expect(m1.equals(m3)).toBe(false);
    expect(m1.isLessThan(m3)).toBe(true);
    expect(m3.isGreaterThan(m1)).toBe(true);
  });

  it('deve lançar erro em operações entre moedas diferentes', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow('Incompatibilidade de moedas');
    expect(() => brl.subtract(usd)).toThrow('Incompatibilidade de moedas');
    expect(() => brl.isLessThan(usd)).toThrow('Incompatibilidade de moedas');
  });

  it('deve rejeitar entradas inválidas: NaN, Infinity, mais de 2 casas, notação científica e strings vazias', () => {
    expect(() => Money.from({ amount: 'NaN', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: 'Infinity', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: '1e5', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: '25.000', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: '', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: 'abc', currency: 'BRL' })).toThrow();
    expect(() => Money.from({ amount: '10.0', currency: 'INVALID' })).toThrow();
  });
});
