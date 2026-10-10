import {
  IsDefined,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MoneyDto } from './money.dto.js';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind.enum.js';

export enum AllowedExternalTransactionKind {
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export class SubmitWagerTransactionDto {
  @IsString({ message: 'providerId deve ser uma string.' })
  @IsNotEmpty({ message: 'providerId não pode ser vazio.' })
  providerId!: string;

  @IsString({ message: 'externalTransactionId deve ser uma string.' })
  @IsNotEmpty({ message: 'externalTransactionId não pode ser vazio.' })
  externalTransactionId!: string;

  @IsUUID('all', { message: 'playerId deve ser um UUID válido.' })
  playerId!: string;

  @IsUUID('all', { message: 'walletId deve ser um UUID válido.' })
  walletId!: string;

  @IsString({ message: 'roundId deve ser uma string.' })
  @IsNotEmpty({ message: 'roundId não pode ser vazio.' })
  roundId!: string;

  @IsString({ message: 'gameId deve ser uma string.' })
  @IsNotEmpty({ message: 'gameId não pode ser vazio.' })
  gameId!: string;

  @IsEnum(AllowedExternalTransactionKind, {
    message: 'kind deve ser BET, WIN, LOSS, REFUND ou ROLLBACK. A operação OPENING é estritamente interna.',
  })
  kind!: AllowedExternalTransactionKind;

  @IsDefined({ message: 'money é obrigatório.' })
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString({ message: 'referenceExternalTransactionId deve ser uma string.' })
  @IsNotEmpty({ message: 'referenceExternalTransactionId não pode ser uma string vazia quando informada.' })
  referenceExternalTransactionId?: string;

  public toDomainKind(): WagerTransactionKind {
    return this.kind as unknown as WagerTransactionKind;
  }
}
