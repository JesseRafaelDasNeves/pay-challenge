import { Module } from '@nestjs/common';
import { CreateWalletUseCase } from './use-cases/create-wallet.use-case.js';
import { GetWalletUseCase } from './use-cases/get-wallet.use-case.js';
import { GetWalletLedgerUseCase } from './use-cases/get-wallet-ledger.use-case.js';
import { GetWagerTransactionUseCase } from './use-cases/get-wager-transaction.use-case.js';
import { ProcessWagerTransactionUseCase } from './use-cases/process-wager-transaction.use-case.js';
import { ReconcileWalletUseCase } from './use-cases/reconcile-wallet.use-case.js';
import { ReprocessPendingReferencesUseCase } from './use-cases/reprocess-pending-references.use-case.js';

@Module({
  providers: [
    CreateWalletUseCase,
    GetWalletUseCase,
    GetWalletLedgerUseCase,
    GetWagerTransactionUseCase,
    ProcessWagerTransactionUseCase,
    ReconcileWalletUseCase,
    ReprocessPendingReferencesUseCase,
  ],
  exports: [
    CreateWalletUseCase,
    GetWalletUseCase,
    GetWalletLedgerUseCase,
    GetWagerTransactionUseCase,
    ProcessWagerTransactionUseCase,
    ReconcileWalletUseCase,
    ReprocessPendingReferencesUseCase,
  ],
})
export class ApplicationModule {}
