import { Decimal } from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private readonly value: Decimal;
  public readonly currency: string;

  private constructor(value: Decimal, currency: string) {
    this.value = value;
    this.currency = currency.toUpperCase();
  }

  public static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string' || typeof props.currency !== 'string') {
      throw new Error('Propriedades inválidas para Money: amount e currency devem ser strings.');
    }

    const trimmedAmount = props.amount.trim();
    const trimmedCurrency = props.currency.trim().toUpperCase();

    if (!trimmedCurrency || trimmedCurrency.length !== 3) {
      throw new Error(`Código de moeda inválido: "${props.currency}". Deve seguir ISO-4217 (ex: BRL).`);
    }

    // Valida formato estrito de string decimal (até 2 casas decimais, sem notação científica ou caracteres estranhos)
    const decimalRegex = /^-?\d+(\.\d{1,2})?$/;
    if (!decimalRegex.test(trimmedAmount)) {
      throw new Error(
        `Formato de valor inválido: "${props.amount}". Deve ser string numérica com no máximo 2 casas decimais.`,
      );
    }

    const decimalValue = new Decimal(trimmedAmount);

    if (decimalValue.isNaN() || !decimalValue.isFinite()) {
      throw new Error(`Valor monetário inválido: "${props.amount}".`);
    }

    return new Money(decimalValue, trimmedCurrency);
  }

  public static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  get amount(): string {
    return this.value.toFixed(2);
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  public negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  public isZero(): boolean {
    return this.value.isZero();
  }

  public isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  public isNegative(): boolean {
    return this.value.isNegative();
  }

  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  public isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  public equals(other: Money): boolean {
    if (!other || this.currency !== other.currency) {
      return false;
    }
    return this.value.equals(other.value);
  }

  public toJSON(): MoneyProps {
    return {
      amount: this.amount,
      currency: this.currency,
    };
  }

  public toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (!other || this.currency !== other.currency) {
      throw new Error(
        `Incompatibilidade de moedas: operação entre ${this.currency} e ${other ? other.currency : 'indefinida'}.`,
      );
    }
  }
}
