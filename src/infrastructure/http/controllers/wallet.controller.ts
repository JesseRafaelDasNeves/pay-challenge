import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CreateWalletDto } from '../../../application/dtos/create-wallet.dto.js';
import { LedgerQueryDto } from '../../../application/dtos/ledger-query.dto.js';
import { CreateWalletUseCase } from '../../../application/use-cases/create-wallet.use-case.js';
import { GetWalletUseCase } from '../../../application/use-cases/get-wallet.use-case.js';
import { GetWalletLedgerUseCase } from '../../../application/use-cases/get-wallet-ledger.use-case.js';
import { ReconcileWalletUseCase } from '../../../application/use-cases/reconcile-wallet.use-case.js';

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly getWalletUseCase: GetWalletUseCase,
    private readonly getWalletLedgerUseCase: GetWalletLedgerUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  public async createWallet(@Body() dto: CreateWalletDto) {
    return this.createWalletUseCase.execute({
      playerId: dto.playerId,
      initialBalance: dto.initialBalance,
    });
  }

  @Get(':walletId')
  public async getWallet(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    return this.getWalletUseCase.execute(walletId);
  }

  @Get(':walletId/ledger')
  public async getLedger(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Query() query: LedgerQueryDto,
  ) {
    return this.getWalletLedgerUseCase.execute(walletId, query.limit, query.cursor);
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  public async reconcile(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    return this.reconcileWalletUseCase.execute(walletId);
  }
}
