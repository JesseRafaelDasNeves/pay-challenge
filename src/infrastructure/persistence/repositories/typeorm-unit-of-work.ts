import { DataSource } from 'typeorm';
import {
  TransactionalContext,
  UnitOfWorkPort,
} from '../../../application/ports/unit-of-work.port.js';
import { TypeOrmWalletRepository } from './typeorm-wallet.repository.js';
import { TypeOrmWalletLedgerRepository } from './typeorm-wallet-ledger.repository.js';
import { TypeOrmWagerTransactionRepository } from './typeorm-wager-transaction.repository.js';
import { TypeOrmInboxRepository } from './typeorm-inbox.repository.js';
import { TypeOrmOutboxRepository } from './typeorm-outbox.repository.js';

export class TypeOrmUnitOfWork implements UnitOfWorkPort {
  constructor(private readonly dataSource: DataSource) {}

  public async executeInTransaction<T>(
    work: (ctx: TransactionalContext) => Promise<T>,
  ): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const context: TransactionalContext = {
        wallets: new TypeOrmWalletRepository(queryRunner.manager),
        ledgers: new TypeOrmWalletLedgerRepository(queryRunner.manager),
        transactions: new TypeOrmWagerTransactionRepository(queryRunner.manager),
        inbox: new TypeOrmInboxRepository(queryRunner.manager),
        outbox: new TypeOrmOutboxRepository(queryRunner.manager),
      };

      const result = await work(context);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
