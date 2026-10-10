import { DataSource, DataSourceOptions } from 'typeorm';
import { envConfig } from '../config/env.config.js';
import { WalletOrmEntity } from './entities/wallet.orm-entity.js';
import { WalletLedgerOrmEntity } from './entities/wallet-ledger.orm-entity.js';
import { WagerTransactionOrmEntity } from './entities/wager-transaction.orm-entity.js';
import { InboxMessageOrmEntity } from './entities/inbox-message.orm-entity.js';
import { OutboxMessageOrmEntity } from './entities/outbox-message.orm-entity.js';
import { InitialSchema1700000000000 } from './migrations/1700000000000-initial-schema.js';

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: envConfig.postgres.host,
  port: envConfig.postgres.port,
  username: envConfig.postgres.user,
  password: envConfig.postgres.password,
  database: envConfig.postgres.database,
  entities: [
    WalletOrmEntity,
    WalletLedgerOrmEntity,
    WagerTransactionOrmEntity,
    InboxMessageOrmEntity,
    OutboxMessageOrmEntity,
  ],
  migrations: [InitialSchema1700000000000],
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
};

export const AppDataSource = new DataSource(dataSourceOptions);
