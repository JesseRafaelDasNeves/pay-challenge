import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source.js';
import { WalletOrmEntity } from './entities/wallet.orm-entity.js';
import { WalletLedgerOrmEntity } from './entities/wallet-ledger.orm-entity.js';
import { WagerTransactionOrmEntity } from './entities/wager-transaction.orm-entity.js';
import { InboxMessageOrmEntity } from './entities/inbox-message.orm-entity.js';
import { OutboxMessageOrmEntity } from './entities/outbox-message.orm-entity.js';
import { WALLET_REPOSITORY_PORT } from '../../application/ports/wallet.repository.port.js';
import { WALLET_LEDGER_REPOSITORY_PORT } from '../../application/ports/wallet-ledger.repository.port.js';
import { WAGER_TRANSACTION_REPOSITORY_PORT } from '../../application/ports/wager-transaction.repository.port.js';
import { INBOX_REPOSITORY_PORT } from '../../application/ports/inbox.repository.port.js';
import { OUTBOX_REPOSITORY_PORT } from '../../application/ports/outbox.repository.port.js';
import { UNIT_OF_WORK_PORT } from '../../application/ports/unit-of-work.port.js';
import { TypeOrmWalletRepository } from './repositories/typeorm-wallet.repository.js';
import { TypeOrmWalletLedgerRepository } from './repositories/typeorm-wallet-ledger.repository.js';
import { TypeOrmWagerTransactionRepository } from './repositories/typeorm-wager-transaction.repository.js';
import { TypeOrmInboxRepository } from './repositories/typeorm-inbox.repository.js';
import { TypeOrmOutboxRepository } from './repositories/typeorm-outbox.repository.js';
import { TypeOrmUnitOfWork } from './repositories/typeorm-unit-of-work.js';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRoot(dataSourceOptions),
    TypeOrmModule.forFeature([
      WalletOrmEntity,
      WalletLedgerOrmEntity,
      WagerTransactionOrmEntity,
      InboxMessageOrmEntity,
      OutboxMessageOrmEntity,
    ]),
  ],
  providers: [
    {
      provide: WALLET_REPOSITORY_PORT,
      useFactory: (dataSource: DataSource) => new TypeOrmWalletRepository(dataSource.manager),
      inject: [DataSource],
    },
    {
      provide: WALLET_LEDGER_REPOSITORY_PORT,
      useFactory: (dataSource: DataSource) => new TypeOrmWalletLedgerRepository(dataSource.manager),
      inject: [DataSource],
    },
    {
      provide: WAGER_TRANSACTION_REPOSITORY_PORT,
      useFactory: (dataSource: DataSource) =>
        new TypeOrmWagerTransactionRepository(dataSource.manager),
      inject: [DataSource],
    },
    {
      provide: INBOX_REPOSITORY_PORT,
      useFactory: (dataSource: DataSource) => new TypeOrmInboxRepository(dataSource.manager),
      inject: [DataSource],
    },
    {
      provide: OUTBOX_REPOSITORY_PORT,
      useFactory: (dataSource: DataSource) => new TypeOrmOutboxRepository(dataSource.manager),
      inject: [DataSource],
    },
    {
      provide: UNIT_OF_WORK_PORT,
      useFactory: (dataSource: DataSource) => new TypeOrmUnitOfWork(dataSource),
      inject: [DataSource],
    },
  ],
  exports: [
    TypeOrmModule,
    WALLET_REPOSITORY_PORT,
    WALLET_LEDGER_REPOSITORY_PORT,
    WAGER_TRANSACTION_REPOSITORY_PORT,
    INBOX_REPOSITORY_PORT,
    OUTBOX_REPOSITORY_PORT,
    UNIT_OF_WORK_PORT,
  ],
})
export class PersistenceModule {}
