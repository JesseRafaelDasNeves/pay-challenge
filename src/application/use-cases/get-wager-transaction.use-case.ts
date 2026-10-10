import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  WAGER_TRANSACTION_REPOSITORY_PORT,
  type WagerTransactionRepositoryPort,
} from '../ports/wager-transaction.repository.port.js';

export interface GetWagerTransactionResult {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: {
    amount: string;
    currency: string;
  };
  status: string;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
  createdAt: string;
  processedAt?: string;
}

@Injectable()
export class GetWagerTransactionUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY_PORT)
    private readonly transactionRepository: WagerTransactionRepositoryPort,
  ) {}

  public async getById(id: string): Promise<GetWagerTransactionResult> {
    const tx = await this.transactionRepository.findById(id);
    if (!tx) {
      throw new NotFoundException(`Transação com ID ${id} não encontrada.`);
    }
    return this.mapToResult(tx);
  }

  public async getByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<GetWagerTransactionResult> {
    const tx = await this.transactionRepository.findByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
    if (!tx) {
      throw new NotFoundException(
        `Transação com externalTransactionId ${externalTransactionId} do provedor ${providerId} não encontrada.`,
      );
    }
    return this.mapToResult(tx);
  }

  private mapToResult(tx: NonNullable<Awaited<ReturnType<WagerTransactionRepositoryPort['findById']>>>): GetWagerTransactionResult {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      status: tx.status,
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      referenceTransactionId: tx.referenceTransactionId,
      failureCode: tx.failureCode,
      createdAt: tx.createdAt.toISOString(),
      processedAt: tx.processedAt?.toISOString(),
    };
  }
}
