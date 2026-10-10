import { IsString, Matches } from 'class-validator';

export class MoneyDto {
  @IsString({ message: 'amount deve ser uma string.' })
  @Matches(/^\d+(\.\d{2})$/, {
    message:
      'amount deve ser uma string numérica decimal não-negativa com exatamente 2 casas decimais (ex: "25.00"). Notação científica, frações com mais ou menos casas e valores negativos não são permitidos.',
  })
  amount!: string;

  @IsString({ message: 'currency deve ser uma string.' })
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency deve ser um código de 3 letras maiúsculas no formato ISO-4217 (ex: BRL).',
  })
  currency!: string;
}
