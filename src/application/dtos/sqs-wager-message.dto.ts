import { IsDefined, IsISO8601, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { SubmitWagerTransactionDto } from './submit-wager-transaction.dto.js';

export class SqsWagerTransactionDataDto extends SubmitWagerTransactionDto {
  @IsOptional()
  @IsString({ message: 'idempotencyKey deve ser uma string.' })
  @IsNotEmpty({ message: 'idempotencyKey não pode ser vazio quando fornecido.' })
  idempotencyKey?: string;
}

export class SqsWagerMessageDto {
  @IsString({ message: 'messageId deve ser uma string.' })
  @IsNotEmpty({ message: 'messageId não pode ser vazio.' })
  messageId!: string;

  @IsString({ message: 'type deve ser uma string.' })
  @IsNotEmpty({ message: 'type não pode ser vazio.' })
  type!: string;

  @IsISO8601({}, { message: 'occurredAt deve ser uma data ISO-8601 válida.' })
  occurredAt!: string;

  @IsDefined({ message: 'data é obrigatório.' })
  @ValidateNested()
  @Type(() => SqsWagerTransactionDataDto)
  data!: SqsWagerTransactionDataDto;
}
