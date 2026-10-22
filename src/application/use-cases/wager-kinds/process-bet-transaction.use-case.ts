import { Injectable } from '@nestjs/common';
import {
  BaseWagerTransactionKindUseCase,
  type WagerTransactionKindExecutionParams,
} from './wager-transaction-kind.use-case.js';
import type { ProcessWagerTransactionResult } from '../process-wager-transaction.use-case.js';
import { WagerTransactionKind } from '../../../domain/wagering/wager-transaction-kind.enum.js';
import { FailureCode } from '../../../domain/wagering/failure-code.enum.js';
import { LedgerDirection } from '../../../domain/wallet/ledger-direction.enum.js';

@Injectable()
export class ProcessBetTransactionUseCase extends BaseWagerTransactionKindUseCase {
  public readonly kind = WagerTransactionKind.Bet;

  public async execute(
    params: WagerTransactionKindExecutionParams,
  ): Promise<ProcessWagerTransactionResult> {
    const { wallet, tx, money, now } = params;

    if (wallet.balance.isLessThan(money)) {
      return this.rejectTransaction(params, FailureCode.InsufficientFunds);
    }

    const mutation = wallet.debit(money, now);
    tx.markProcessed(undefined, now);

    return this.applyBalanceMutationAndPublish(params, LedgerDirection.Debit, mutation);
  }
}

