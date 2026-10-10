import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { WALLET_REPOSITORY_PORT, type WalletRepositoryPort } from '../ports/wallet.repository.port.js';
import {
  WALLET_LEDGER_REPOSITORY_PORT,
  type WalletLedgerRepositoryPort,
} from '../ports/wallet-ledger.repository.port.js';
import { Money, MoneyProps } from '../../domain/shared/money.value-object.js';

export interface ReconcileWalletResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(
    @Inject(WALLET_REPOSITORY_PORT)
    private readonly walletRepository: WalletRepositoryPort,
    @Inject(WALLET_LEDGER_REPOSITORY_PORT)
    private readonly ledgerRepository: WalletLedgerRepositoryPort,
  ) {}

  public async execute(walletId: string): Promise<ReconcileWalletResult> {
    const wallet = await this.walletRepository.findById(walletId);
    if (!wallet) {
      throw new NotFoundException(`Carteira com ID ${walletId} não encontrada.`);
    }

    const summary = await this.ledgerRepository.sumEntriesByWalletId(walletId);

    const totalCredits = Money.from({ amount: summary.totalCredits, currency: wallet.currency });
    const totalDebits = Money.from({ amount: summary.totalDebits, currency: wallet.currency });

    // Saldo calculado a partir do livro razão: total créditos - total débitos
    const calculated = totalCredits.subtract(totalDebits);
    const stored = wallet.balance;

    const difference = stored.subtract(calculated);
    const consistent = difference.isZero();

    if (!consistent) {
      this.logger.error(
        JSON.stringify({
          event: 'WALLET_RECONCILIATION_DIVERGENCE',
          walletId,
          storedBalance: stored.amount,
          calculatedBalance: calculated.amount,
          difference: difference.amount,
          currency: wallet.currency,
          checkedEntries: summary.count,
        }),
      );
    }

    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: summary.count,
    };
  }
}
