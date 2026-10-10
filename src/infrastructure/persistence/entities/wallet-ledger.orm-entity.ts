import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger.entity.js';
import { LedgerDirection } from '../../../domain/wallet/ledger-direction.enum.js';
import { Money } from '../../../domain/shared/money.value-object.js';

@Entity({ name: 'wallet_ledger_entries' })
export class WalletLedgerOrmEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Column({ type: 'varchar', length: 10 })
  direction!: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount!: string;

  @Column({ type: 'varchar', length: 3, default: 'BRL' })
  currency!: string;

  @Column({ name: 'balance_before', type: 'numeric', precision: 18, scale: 2 })
  balanceBefore!: string;

  @Column({ name: 'balance_after', type: 'numeric', precision: 18, scale: 2 })
  balanceAfter!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  public toDomain(): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: this.id,
      walletId: this.walletId,
      transactionId: this.transactionId,
      direction: this.direction as LedgerDirection,
      money: Money.from({ amount: this.amount, currency: this.currency }),
      balanceBefore: Money.from({ amount: this.balanceBefore, currency: this.currency }),
      balanceAfter: Money.from({ amount: this.balanceAfter, currency: this.currency }),
      createdAt: this.createdAt,
    });
  }

  public static fromDomain(ledger: WalletLedgerEntry): WalletLedgerOrmEntity {
    const entity = new WalletLedgerOrmEntity();
    entity.id = ledger.id;
    entity.walletId = ledger.walletId;
    entity.transactionId = ledger.transactionId;
    entity.direction = ledger.direction;
    entity.amount = ledger.money.amount;
    entity.currency = ledger.money.currency;
    entity.balanceBefore = ledger.balanceBefore.amount;
    entity.balanceAfter = ledger.balanceAfter.amount;
    entity.createdAt = ledger.createdAt;
    return entity;
  }
}
