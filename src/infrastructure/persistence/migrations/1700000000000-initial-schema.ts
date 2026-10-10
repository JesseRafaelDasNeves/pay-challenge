import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Tabela wallets
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS wallets (
        id UUID NOT NULL,
        player_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL DEFAULT 'BRL',
        balance_amount NUMERIC(18, 2) NOT NULL DEFAULT 0.00,
        version BIGINT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT pk_wallets PRIMARY KEY (id),
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT chk_wallets_balance_non_negative CHECK (balance_amount >= 0),
        CONSTRAINT chk_wallets_version_positive CHECK (version >= 1)
      );
    `);

    // 2. Tabela wager_transactions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS wager_transactions (
        id UUID NOT NULL,
        provider_id VARCHAR(64) NOT NULL,
        external_transaction_id VARCHAR(128) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        wallet_id UUID NOT NULL,
        player_id UUID NOT NULL,
        round_id VARCHAR(128) NOT NULL,
        game_id VARCHAR(128) NOT NULL,
        kind VARCHAR(20) NOT NULL,
        amount NUMERIC(18, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL DEFAULT 'BRL',
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        reference_external_transaction_id VARCHAR(128) NULL,
        reference_transaction_id UUID NULL,
        failure_code VARCHAR(64) NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMPTZ NULL,

        CONSTRAINT pk_wager_transactions PRIMARY KEY (id),
        CONSTRAINT fk_wager_tx_wallet FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE RESTRICT,
        CONSTRAINT fk_wager_tx_reference FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions(id) ON DELETE RESTRICT,
        CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT chk_wager_tx_kind CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT chk_wager_tx_status CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT chk_wager_tx_amount_positive CHECK (amount >= 0)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_wager_tx_wallet_created ON wager_transactions (wallet_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_wager_tx_round_player ON wager_transactions (round_id, player_id);
      CREATE INDEX IF NOT EXISTS idx_wager_tx_pending_reference ON wager_transactions (created_at ASC) WHERE status = 'PENDING_REFERENCE';
      CREATE UNIQUE INDEX IF NOT EXISTS uq_wager_tx_single_reversal ON wager_transactions (reference_transaction_id, kind)
        WHERE reference_transaction_id IS NOT NULL AND status = 'PROCESSED';
    `);

    // 3. Tabela wallet_ledger_entries
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
        id UUID NOT NULL,
        wallet_id UUID NOT NULL,
        transaction_id UUID NOT NULL,
        direction VARCHAR(10) NOT NULL,
        amount NUMERIC(18, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL DEFAULT 'BRL',
        balance_before NUMERIC(18, 2) NOT NULL,
        balance_after NUMERIC(18, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT pk_wallet_ledger_entries PRIMARY KEY (id),
        CONSTRAINT fk_ledger_wallet FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE RESTRICT,
        CONSTRAINT fk_ledger_transaction FOREIGN KEY (transaction_id) REFERENCES wager_transactions(id) ON DELETE RESTRICT,
        CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id),
        CONSTRAINT chk_ledger_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0),
        CONSTRAINT chk_ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT chk_ledger_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_ledger_wallet_cursor ON wallet_ledger_entries (wallet_id, created_at DESC, id DESC);
    `);

    // Trigger de imutabilidade do ledger (append-only)
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION fn_prevent_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Operação não permitida: registros de wallet_ledger_entries são estritamente imutáveis (append-only).';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_prevent_ledger_mutation ON wallet_ledger_entries;
      CREATE TRIGGER trg_prevent_ledger_mutation
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION fn_prevent_ledger_mutation();
    `);

    // 4. Tabela inbox_messages
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS inbox_messages (
        consumer_name VARCHAR(64) NOT NULL,
        message_id VARCHAR(128) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMPTZ NULL,

        CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_processed ON inbox_messages (consumer_name, processed_at);
    `);

    // 5. Tabela outbox_messages
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS outbox_messages (
        id UUID NOT NULL,
        aggregate_id VARCHAR(64) NOT NULL,
        event_type VARCHAR(128) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NULL,
        published_at TIMESTAMPTZ NULL,
        last_error TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT pk_outbox_messages PRIMARY KEY (id),
        CONSTRAINT chk_outbox_attempts CHECK (attempts >= 0)
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_pending_polling ON outbox_messages (occurred_at ASC)
        WHERE published_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS outbox_messages;`);
    await queryRunner.query(`DROP TABLE IF EXISTS inbox_messages;`);
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_prevent_ledger_mutation ON wallet_ledger_entries;`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS fn_prevent_ledger_mutation;`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallet_ledger_entries;`);
    await queryRunner.query(`DROP TABLE IF EXISTS wager_transactions;`);
    await queryRunner.query(`DROP TABLE IF EXISTS wallets;`);
  }
}
