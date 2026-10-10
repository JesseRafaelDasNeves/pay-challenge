import { Money } from '../shared/money.value-object.js';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  createdAt?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BalanceMutationResult {
  balanceBefore: Money;
  balanceAfter: Money;
  versionBefore: number;
  versionAfter: number;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  public static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    createdAt?: Date;
  }): Wallet {
    if (!props.id || !props.playerId) {
      throw new Error('Identificadores obrigatórios ausentes ao abrir wallet.');
    }

    if (props.initialBalance.isNegative()) {
      throw new Error('Saldo inicial da carteira não pode ser negativo.');
    }

    const now = props.createdAt ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1, // Versão inicial = 1
      now,
      now,
    );
  }

  public static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  public debit(amount: Money, at?: Date): BalanceMutationResult {
    this.assertSameCurrency(amount);

    if (amount.isZero() || amount.isNegative()) {
      throw new Error('O valor do débito deve ser estritamente positivo.');
    }

    if (this._balance.isLessThan(amount)) {
      throw new Error('Saldo insuficiente para realizar o débito.');
    }

    const balanceBefore = this._balance;
    const versionBefore = this._version;

    this._balance = this._balance.subtract(amount);
    this._version += 1;
    this._updatedAt = at ?? new Date();

    return {
      balanceBefore,
      balanceAfter: this._balance,
      versionBefore,
      versionAfter: this._version,
    };
  }

  public credit(amount: Money, at?: Date): BalanceMutationResult {
    this.assertSameCurrency(amount);

    if (amount.isZero() || amount.isNegative()) {
      throw new Error('O valor do crédito deve ser estritamente positivo.');
    }

    const balanceBefore = this._balance;
    const versionBefore = this._version;

    this._balance = this._balance.add(amount);
    this._version += 1;
    this._updatedAt = at ?? new Date();

    return {
      balanceBefore,
      balanceAfter: this._balance,
      versionBefore,
      versionAfter: this._version,
    };
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new Error(
        `Incompatibilidade de moedas: carteira (${this.currency}) e valor da operação (${money.currency}).`,
      );
    }
  }
}
