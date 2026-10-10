import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger.entity.js';

export const WALLET_LEDGER_REPOSITORY_PORT = Symbol('WALLET_LEDGER_REPOSITORY_PORT');

export interface PaginatedLedgerResult {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}

export interface LedgerReconciliationSummary {
  totalCredits: string;
  totalDebits: string;
  count: number;
}

export interface WalletLedgerRepositoryPort {
  save(entry: WalletLedgerEntry): Promise<void>;
  findByWalletId(walletId: string, limit: number, cursor?: string): Promise<PaginatedLedgerResult>;
  sumEntriesByWalletId(walletId: string): Promise<LedgerReconciliationSummary>;
}
