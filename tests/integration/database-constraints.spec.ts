import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AppDataSource } from '../../src/infrastructure/persistence/data-source.js';

describe('Integração: PostgreSQL Constraints e Triggers Reais', () => {
  beforeAll(async () => {
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  });

  it('deve rejeitar saldo negativo no banco de dados com violação de CHECK constraint', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();

    const promise = AppDataSource.query(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES ($1, $2, 'BRL', -10.00, 1)`,
      [walletId, playerId],
    );

    expect(promise).rejects.toThrow(/chk_wallets_balance_non_negative/);
  });

  it('deve rejeitar carteira duplicada para o mesmo player_id e currency com violação de UNIQUE constraint', async () => {
    const walletId1 = randomUUID();
    const walletId2 = randomUUID();
    const playerId = randomUUID();

    await AppDataSource.query(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES ($1, $2, 'BRL', 50.00, 1)`,
      [walletId1, playerId],
    );

    const promise = AppDataSource.query(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES ($1, $2, 'BRL', 50.00, 1)`,
      [walletId2, playerId],
    );

    expect(promise).rejects.toThrow(/uq_wallets_player_currency/);
  });

  it('deve bloquear UPDATE em wallet_ledger_entries através do Trigger de Imutabilidade do PostgreSQL', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const txId = randomUUID();
    const ledgerId = randomUUID();
    const extId = randomUUID();
    const key = randomUUID();

    await AppDataSource.query(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES ($1, $2, 'BRL', 100.00, 1)`,
      [walletId, playerId],
    );

    await AppDataSource.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
       VALUES ($1, 'prov', $2, $3, 'hash', $4, $5, 'r1', 'g1', 'BET', 50.00, 'BRL', 'PROCESSED')`,
      [txId, extId, key, walletId, playerId],
    );

    await AppDataSource.query(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 'DEBIT', 50.00, 'BRL', 100.00, 50.00)`,
      [ledgerId, walletId, txId],
    );

    // Tentativa de alterar o lançamento contábil deve ser bloqueada pelo trigger
    const updatePromise = AppDataSource.query(
      `UPDATE wallet_ledger_entries SET amount = 999.00 WHERE id = $1`,
      [ledgerId],
    );

    expect(updatePromise).rejects.toThrow(/são estritamente imutáveis/);
  });

  it('deve bloquear DELETE em wallet_ledger_entries através do Trigger de Imutabilidade do PostgreSQL', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const txId = randomUUID();
    const ledgerId = randomUUID();
    const extId = randomUUID();
    const key = randomUUID();

    await AppDataSource.query(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES ($1, $2, 'BRL', 100.00, 1)`,
      [walletId, playerId],
    );

    await AppDataSource.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
       VALUES ($1, 'prov', $2, $3, 'hash', $4, $5, 'r1', 'g1', 'BET', 20.00, 'BRL', 'PROCESSED')`,
      [txId, extId, key, walletId, playerId],
    );

    await AppDataSource.query(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 'DEBIT', 20.00, 'BRL', 100.00, 80.00)`,
      [ledgerId, walletId, txId],
    );

    const deletePromise = AppDataSource.query(
      `DELETE FROM wallet_ledger_entries WHERE id = $1`,
      [ledgerId],
    );

    expect(deletePromise).rejects.toThrow(/são estritamente imutáveis/);
  });

  it('deve rejeitar no banco lançamentos contábeis com equação aritmética inconsistente', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const txId = randomUUID();
    const ledgerId = randomUUID();
    const extId = randomUUID();
    const key = randomUUID();

    await AppDataSource.query(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES ($1, $2, 'BRL', 100.00, 1)`,
      [walletId, playerId],
    );

    await AppDataSource.query(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
       VALUES ($1, 'prov', $2, $3, 'hash', $4, $5, 'r1', 'g1', 'BET', 30.00, 'BRL', 'PROCESSED')`,
      [txId, extId, key, walletId, playerId],
    );

    // Incorreto: 100.00 - 30.00 = 70.00, mas balance_after inserido como 60.00
    const invalidEquationPromise = AppDataSource.query(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       VALUES ($1, $2, $3, 'DEBIT', 30.00, 'BRL', 100.00, 60.00)`,
      [ledgerId, walletId, txId],
    );

    expect(invalidEquationPromise).rejects.toThrow(/chk_ledger_balanced/);
  });
});
