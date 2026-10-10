import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { SubmitWagerTransactionDto } from '../../../application/dtos/submit-wager-transaction.dto.js';
import { ProcessWagerTransactionUseCase } from '../../../application/use-cases/process-wager-transaction.use-case.js';
import { GetWagerTransactionUseCase } from '../../../application/use-cases/get-wager-transaction.use-case.js';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status.enum.js';

@Controller()
export class WageringController {
  constructor(
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    private readonly getWagerUseCase: GetWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  public async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: SubmitWagerTransactionDto,
    @Res() res: Response,
  ) {
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new BadRequestException('O header Idempotency-Key é obrigatório.');
    }

    const result = await this.processWagerUseCase.execute({
      idempotencyKey: idempotencyKey.trim(),
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.toDomainKind(),
      money: dto.money,
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
    });

    let httpStatus = 200;
    if (result.status === WagerTransactionStatus.PendingReference) {
      httpStatus = 202; // Aceito com processamento assíncrono pendente
    } else if (result.status === WagerTransactionStatus.Rejected) {
      httpStatus = 422; // Rejeição por violação de regra de negócio
    } else if (result.status === WagerTransactionStatus.Failed) {
      httpStatus = 500; // Erro de infraestrutura
    }

    return res.status(httpStatus).json(result);
  }

  @Get('wagering/transactions/:transactionId')
  public async getTransaction(
    @Param('transactionId', new ParseUUIDPipe()) transactionId: string,
  ) {
    return this.getWagerUseCase.getById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  public async getTransactionByProvider(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return this.getWagerUseCase.getByProviderAndExternalId(providerId, externalTransactionId);
  }
}
