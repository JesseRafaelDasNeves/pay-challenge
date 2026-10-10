import { Wallet } from '../../domain/wallet/wallet.aggregate.js';

export const WALLET_REPOSITORY_PORT = Symbol('WALLET_REPOSITORY_PORT');

export interface WalletRepositoryPort {
  findById(id: string, lock?: 'pessimistic_write'): Promise<Wallet | null>;
  findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  save(wallet: Wallet): Promise<void>;
}
