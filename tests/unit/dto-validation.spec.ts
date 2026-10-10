import 'reflect-metadata';
import { describe, expect, it } from 'bun:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MoneyDto } from '../../src/application/dtos/money.dto.js';
import { CreateWalletDto } from '../../src/application/dtos/create-wallet.dto.js';
import {
  AllowedExternalTransactionKind,
  SubmitWagerTransactionDto,
} from '../../src/application/dtos/submit-wager-transaction.dto.js';
import { LedgerQueryDto } from '../../src/application/dtos/ledger-query.dto.js';

describe('Camada de Validação de DTOs (class-validator)', () => {
  describe('MoneyDto', () => {
    it('deve validar com sucesso um MoneyDto correto', async () => {
      const dto = plainToInstance(MoneyDto, { amount: '25.00', currency: 'BRL' });
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('deve rejeitar montantes com formato decimal inválido', async () => {
      // 3 casas decimais
      const dto3Casas = plainToInstance(MoneyDto, { amount: '25.001', currency: 'BRL' });
      const err3Casas = await validate(dto3Casas);
      expect(err3Casas.length).toBeGreaterThan(0);

      // Notação científica
      const dtoCientifico = plainToInstance(MoneyDto, { amount: '1e5', currency: 'BRL' });
      const errCientifico = await validate(dtoCientifico);
      expect(errCientifico.length).toBeGreaterThan(0);

      // Valor negativo
      const dtoNegativo = plainToInstance(MoneyDto, { amount: '-25.00', currency: 'BRL' });
      const errNegativo = await validate(dtoNegativo);
      expect(errNegativo.length).toBeGreaterThan(0);

      // Moeda inválida (minúsculas ou comprimento errado)
      const dtoMoeda = plainToInstance(MoneyDto, { amount: '25.00', currency: 'brl' });
      const errMoeda = await validate(dtoMoeda);
      expect(errMoeda.length).toBeGreaterThan(0);
    });
  });

  describe('CreateWalletDto', () => {
    it('deve aceitar UUID e initialBalance válidos', async () => {
      const dto = plainToInstance(CreateWalletDto, {
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('deve rejeitar playerId que não seja UUID', async () => {
      const dto = plainToInstance(CreateWalletDto, {
        playerId: 'player-123-nao-uuid',
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('SubmitWagerTransactionDto', () => {
    it('deve validar com sucesso uma aposta BET válida', async () => {
      const dto = plainToInstance(SubmitWagerTransactionDto, {
        providerId: 'provider-a',
        externalTransactionId: 'tx-999',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: AllowedExternalTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      });
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('deve rejeitar submissão com tipo OPENING (estritamente interno)', async () => {
      const dto = plainToInstance(SubmitWagerTransactionDto, {
        providerId: 'provider-a',
        externalTransactionId: 'tx-999',
        playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
        walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'OPENING',
        money: { amount: '25.00', currency: 'BRL' },
      });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.property).toBe('kind');
    });
  });

  describe('LedgerQueryDto', () => {
    it('deve validar limites e defaults', async () => {
      const dto = plainToInstance(LedgerQueryDto, { limit: 10, cursor: 'abc' });
      const errors = await validate(dto);
      expect(errors.length).toBe(0);

      // Limite maior que 100
      const dtoExcesso = plainToInstance(LedgerQueryDto, { limit: 150 });
      const errExcesso = await validate(dtoExcesso);
      expect(errExcesso.length).toBeGreaterThan(0);

      // Limite menor que 1
      const dtoZero = plainToInstance(LedgerQueryDto, { limit: 0 });
      const errZero = await validate(dtoZero);
      expect(errZero.length).toBeGreaterThan(0);
    });
  });
});
