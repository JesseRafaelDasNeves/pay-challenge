import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { WagerTransaction } from '../../../domain/wagering/wager-transaction.aggregate.js';
import { WagerTransactionKind } from '../../../domain/wagering/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status.enum.js';
import { FailureCode } from '../../../domain/wagering/failure-code.enum.js';
import { Money } from '../../../domain/shared/money.value-object.js';

@Entity({ name: 'wager_transactions' })
export class WagerTransactionOrmEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'provider_id', type: 'varchar', length: 64 })
  providerId!: string;

  @Column({ name: 'external_transaction_id', type: 'varchar', length: 128 })
  externalTransactionId!: string;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 })
  idempotencyKey!: string;

  @Column({ name: 'payload_hash', type: 'varchar', length: 64 })
  payloadHash!: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Column({ name: 'player_id', type: 'uuid' })
  playerId!: string;

  @Column({ name: 'round_id', type: 'varchar', length: 128 })
  roundId!: string;

  @Column({ name: 'game_id', type: 'varchar', length: 128 })
  gameId!: string;

  @Column({ type: 'varchar', length: 20 })
  kind!: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount!: string;

  @Column({ type: 'varchar', length: 3, default: 'BRL' })
  currency!: string;

  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  status!: string;

  @Column({ name: 'reference_external_transaction_id', type: 'varchar', length: 128, nullable: true })
  referenceExternalTransactionId?: string | null;

  @Column({ name: 'reference_transaction_id', type: 'uuid', nullable: true })
  referenceTransactionId?: string | null;

  @Column({ name: 'failure_code', type: 'varchar', length: 64, nullable: true })
  failureCode?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt?: Date | null;

  public toDomain(): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind as WagerTransactionKind,
      money: Money.from({ amount: this.amount, currency: this.currency }),
      referenceExternalTransactionId: this.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: this.referenceTransactionId ?? undefined,
      failureCode: (this.failureCode as FailureCode) ?? undefined,
      status: this.status as WagerTransactionStatus,
      createdAt: this.createdAt,
      processedAt: this.processedAt ?? undefined,
    });
  }

  public static fromDomain(tx: WagerTransaction): WagerTransactionOrmEntity {
    const entity = new WagerTransactionOrmEntity();
    entity.id = tx.id;
    entity.providerId = tx.providerId;
    entity.externalTransactionId = tx.externalTransactionId;
    entity.idempotencyKey = tx.idempotencyKey;
    entity.payloadHash = tx.payloadHash;
    entity.walletId = tx.walletId;
    entity.playerId = tx.playerId;
    entity.roundId = tx.roundId;
    entity.gameId = tx.gameId;
    entity.kind = tx.kind;
    entity.amount = tx.money.amount;
    entity.currency = tx.money.currency;
    entity.status = tx.status;
    entity.referenceExternalTransactionId = tx.referenceExternalTransactionId ?? null;
    entity.referenceTransactionId = tx.referenceTransactionId ?? null;
    entity.failureCode = tx.failureCode ?? null;
    entity.createdAt = tx.createdAt;
    entity.processedAt = tx.processedAt ?? null;
    return entity;
  }
}
