import { WalletRepositoryPort } from './wallet.repository.port.js';
import { WalletLedgerRepositoryPort } from './wallet-ledger.repository.port.js';
import { WagerTransactionRepositoryPort } from './wager-transaction.repository.port.js';
import { InboxRepositoryPort } from './inbox.repository.port.js';
import { OutboxRepositoryPort } from './outbox.repository.port.js';

export interface TransactionalContext {
  wallets: WalletRepositoryPort;
  ledgers: WalletLedgerRepositoryPort;
  transactions: WagerTransactionRepositoryPort;
  inbox: InboxRepositoryPort;
  outbox: OutboxRepositoryPort;
}

export const UNIT_OF_WORK_PORT = Symbol('UNIT_OF_WORK_PORT');

export interface UnitOfWorkPort {
  executeInTransaction<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;
}
