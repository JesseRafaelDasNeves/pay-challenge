import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { WALLET_REPOSITORY_PORT, type WalletRepositoryPort } from '../ports/wallet.repository.port.js';
import {
  WALLET_LEDGER_REPOSITORY_PORT,
  type WalletLedgerRepositoryPort,
} from '../ports/wallet-ledger.repository.port.js';

export interface LedgerEntryDto {
  id: string;
  walletId: string;
  transactionId: string;
  direction: string;
  money: {
    amount: string;
    currency: string;
  };
  balanceBefore: {
    amount: string;
    currency: string;
  };
  balanceAfter: {
    amount: string;
    currency: string;
  };
  createdAt: string;
}

export interface GetWalletLedgerResult {
  entries: LedgerEntryDto[];
  nextCursor?: string;
}

@Injectable()
export class GetWalletLedgerUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY_PORT)
    private readonly walletRepository: WalletRepositoryPort,
    @Inject(WALLET_LEDGER_REPOSITORY_PORT)
    private readonly ledgerRepository: WalletLedgerRepositoryPort,
  ) {}

  public async execute(
    walletId: string,
    limit: number = 50,
    cursor?: string,
  ): Promise<GetWalletLedgerResult> {
    const wallet = await this.walletRepository.findById(walletId);
    if (!wallet) {
      throw new NotFoundException(`Carteira com ID ${walletId} não encontrada.`);
    }

    const { entries, nextCursor } = await this.ledgerRepository.findByWalletId(
      walletId,
      limit,
      cursor,
    );

    return {
      entries: entries.map((e) => ({
        id: e.id,
        walletId: e.walletId,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor,
    };
  }
}
