import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { Wallet } from '../../../domain/wallet/wallet.aggregate.js';
import { Money } from '../../../domain/shared/money.value-object.js';

@Entity({ name: 'wallets' })
export class WalletOrmEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'player_id', type: 'uuid' })
  playerId!: string;

  @Column({ type: 'varchar', length: 3, default: 'BRL' })
  currency!: string;

  @Column({ name: 'balance_amount', type: 'numeric', precision: 18, scale: 2, default: '0.00' })
  balanceAmount!: string;

  @Column({ type: 'bigint', default: 1 })
  version!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  public toDomain(): Wallet {
    return Wallet.rehydrate({
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: Money.from({ amount: this.balanceAmount, currency: this.currency }),
      version: Number(this.version),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    });
  }

  public static fromDomain(wallet: Wallet): WalletOrmEntity {
    const entity = new WalletOrmEntity();
    entity.id = wallet.id;
    entity.playerId = wallet.playerId;
    entity.currency = wallet.currency;
    entity.balanceAmount = wallet.balance.amount;
    entity.version = String(wallet.version);
    entity.createdAt = wallet.createdAt;
    entity.updatedAt = wallet.updatedAt;
    return entity;
  }
}
