import { Injectable } from '@nestjs/common';
import {
  BaseWagerTransactionKindUseCase,
  type WagerTransactionKindExecutionParams,
} from './wager-transaction-kind.use-case.js';
import type { ProcessWagerTransactionResult } from '../process-wager-transaction.use-case.js';
import { WagerTransactionKind } from '../../../domain/wagering/wager-transaction-kind.enum.js';
import { LedgerDirection } from '../../../domain/wallet/ledger-direction.enum.js';

@Injectable()
export class ProcessWinTransactionUseCase extends BaseWagerTransactionKindUseCase {
  public readonly kind = WagerTransactionKind.Win;

  public async execute(
    params: WagerTransactionKindExecutionParams,
  ): Promise<ProcessWagerTransactionResult> {
    const { wallet, tx, money, now } = params;

    const mutation = wallet.credit(money, now);
    tx.markProcessed(undefined, now);

    return this.applyBalanceMutationAndPublish(params, LedgerDirection.Credit, mutation);
  }
}

