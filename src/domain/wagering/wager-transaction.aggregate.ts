import { Money } from '../shared/money.value-object.js';
import { FailureCode } from './failure-code.enum.js';
import { WagerTransactionKind } from './wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from './wager-transaction-status.enum.js';
import { LedgerDirection } from '../wallet/ledger-direction.enum.js';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  public static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!props.id || !props.providerId || !props.externalTransactionId || !props.walletId || !props.playerId) {
      throw new Error('Campos obrigatórios ausentes para criação de WagerTransaction.');
    }

    if (props.money.isNegative()) {
      throw new Error('Valor da transação não pode ser negativo.');
    }

    // REFUND e ROLLBACK exigem referência externa informada
    if (
      (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId
    ) {
      throw new Error(`Operações do tipo ${props.kind} exigem referenceExternalTransactionId.`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  public static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  public markProcessed(referenceTransactionId?: string, at?: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Processed;
    if (referenceTransactionId) {
      this._referenceTransactionId = referenceTransactionId;
    }
    this._processedAt = at ?? new Date();
  }

  public markPendingReference(): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.PendingReference;
  }

  public reject(code: FailureCode, at?: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at ?? new Date();
  }

  public fail(code: FailureCode, at?: Date): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at ?? new Date();
  }

  public isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  public affectsBalance(): boolean {
    // LOSS e transações rejeitadas/falhas não alteram saldo
    if (this._status === WagerTransactionStatus.Rejected || this._status === WagerTransactionStatus.Failed) {
      return false;
    }
    return this.kind !== WagerTransactionKind.Loss;
  }

  public requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  public matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  public ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new Error('Transação referenciada obrigatória para determinar a direção do ROLLBACK.');
        }
        // Inverte a direção original da referência
        if (reference.kind === WagerTransactionKind.Bet) {
          return LedgerDirection.Credit;
        }
        if (reference.kind === WagerTransactionKind.Win || reference.kind === WagerTransactionKind.Refund) {
          return LedgerDirection.Debit;
        }
        throw new Error(`Tipo de referência ${reference.kind} inválido para reversão por ROLLBACK.`);
      }
      default:
        throw new Error(`A operação ${this.kind} não gera movimentação no ledger.`);
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new Error(
        `Transição inválida: transação ${this.id} já está em estado terminal (${this._status}).`,
      );
    }
  }
}
