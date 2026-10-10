import { IsDefined, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MoneyDto } from './money.dto.js';

export class CreateWalletDto {
  @IsUUID('all', { message: 'playerId deve ser um UUID válido.' })
  playerId!: string;

  @IsDefined({ message: 'initialBalance é obrigatório.' })
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}
