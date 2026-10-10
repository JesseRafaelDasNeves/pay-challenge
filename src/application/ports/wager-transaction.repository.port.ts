import { WagerTransaction } from '../../domain/wagering/wager-transaction.aggregate.js';

export const WAGER_TRANSACTION_REPOSITORY_PORT = Symbol('WAGER_TRANSACTION_REPOSITORY_PORT');

export interface WagerTransactionRepositoryPort {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null>;
  findReferenceTransaction(providerId: string, referenceExternalId: string): Promise<WagerTransaction | null>;
  save(transaction: WagerTransaction): Promise<void>;
  findPendingReferences(limit: number): Promise<WagerTransaction[]>;
}
