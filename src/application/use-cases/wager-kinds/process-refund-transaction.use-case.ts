import { Injectable } from '@nestjs/common';
import {
  BaseWagerTransactionKindUseCase,
  type WagerTransactionKindExecutionParams,
} from './wager-transaction-kind.use-case.js';
import type { ProcessWagerTransactionResult } from '../process-wager-transaction.use-case.js';
import { WagerTransactionKind } from '../../../domain/wagering/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status.enum.js';
import { FailureCode } from '../../../domain/wagering/failure-code.enum.js';
import { LedgerDirection } from '../../../domain/wallet/ledger-direction.enum.js';

@Injectable()
export class ProcessRefundTransactionUseCase extends BaseWagerTransactionKindUseCase {
  public readonly kind = WagerTransactionKind.Refund;

  public async execute(
    params: WagerTransactionKindExecutionParams,
  ): Promise<ProcessWagerTransactionResult> {
    const { ctx, wallet, tx, money, now } = params;
    const referenceExternalId = tx.referenceExternalTransactionId!;

    const refTx = await ctx.transactions.findReferenceTransaction(
      tx.providerId,
      referenceExternalId,
    );

    if (!refTx) {
      // Referência fora de ordem: armazena como PENDING_REFERENCE para reprocessamento
      return this.markPendingReferenceAndPublish(params, referenceExternalId);
    }

    // Validações da referência
    if (refTx.kind !== WagerTransactionKind.Bet) {
      return this.rejectTransaction(params, FailureCode.InvalidReferenceTransaction);
    }
    if (refTx.status !== WagerTransactionStatus.Processed) {
      return this.rejectTransaction(params, FailureCode.InvalidTransactionState);
    }
    if (refTx.roundId !== tx.roundId) {
      return this.rejectTransaction(params, FailureCode.RoundMismatch);
    }
    if (!refTx.money.equals(money)) {
      return this.rejectTransaction(params, FailureCode.AmountMismatch);
    }

    const mutation = wallet.credit(money, now);
    tx.markProcessed(refTx.id, now);

    return this.applyBalanceMutationAndPublish(params, LedgerDirection.Credit, mutation);
  }
}

