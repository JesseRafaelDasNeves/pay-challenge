import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { WALLET_REPOSITORY_PORT, type WalletRepositoryPort } from '../ports/wallet.repository.port.js';

export interface GetWalletResult {
  id: string;
  playerId: string;
  currency: string;
  balance: {
    amount: string;
    currency: string;
  };
  version: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class GetWalletUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY_PORT)
    private readonly walletRepository: WalletRepositoryPort,
  ) {}

  public async execute(walletId: string): Promise<GetWalletResult> {
    const wallet = await this.walletRepository.findById(walletId);
    if (!wallet) {
      throw new NotFoundException(`Carteira com ID ${walletId} não encontrada.`);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }
}
