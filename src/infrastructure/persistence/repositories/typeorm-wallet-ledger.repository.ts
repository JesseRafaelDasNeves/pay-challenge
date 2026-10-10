import { EntityManager } from 'typeorm';
import {
  LedgerReconciliationSummary,
  PaginatedLedgerResult,
  WalletLedgerRepositoryPort,
} from '../../../application/ports/wallet-ledger.repository.port.js';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger.entity.js';
import { WalletLedgerOrmEntity } from '../entities/wallet-ledger.orm-entity.js';

interface DecodedCursor {
  createdAt: string;
  id: string;
}

export class TypeOrmWalletLedgerRepository implements WalletLedgerRepositoryPort {
  constructor(private readonly manager: EntityManager) {}

  public async save(entry: WalletLedgerEntry): Promise<void> {
    const entity = WalletLedgerOrmEntity.fromDomain(entry);
    await this.manager.save(WalletLedgerOrmEntity, entity);
  }

  public async findByWalletId(
    walletId: string,
    limit: number,
    cursor?: string,
  ): Promise<PaginatedLedgerResult> {
    const qb = this.manager
      .createQueryBuilder(WalletLedgerOrmEntity, 'entry')
      .where('entry.wallet_id = :walletId', { walletId });

    if (cursor) {
      try {
        const decoded: DecodedCursor = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
        qb.andWhere(
          '(entry.created_at < :cursorDate OR (entry.created_at = :cursorDate AND entry.id < :cursorId))',
          {
            cursorDate: new Date(decoded.createdAt),
            cursorId: decoded.id,
          },
        );
      } catch {
        // Se o cursor for inválido, ignora ou lança erro
      }
    }

    qb.orderBy('entry.created_at', 'DESC').addOrderBy('entry.id', 'DESC').take(limit + 1);

    const entities = await qb.getMany();
    const hasMore = entities.length > limit;
    const resultEntities = hasMore ? entities.slice(0, limit) : entities;

    let nextCursor: string | undefined;
    if (hasMore && resultEntities.length > 0) {
      const last = resultEntities[resultEntities.length - 1]!;
      const cursorPayload: DecodedCursor = {
        createdAt: last.createdAt.toISOString(),
        id: last.id,
      };
      nextCursor = Buffer.from(JSON.stringify(cursorPayload)).toString('base64');
    }

    return {
      entries: resultEntities.map((e) => e.toDomain()),
      nextCursor,
    };
  }

  public async sumEntriesByWalletId(walletId: string): Promise<LedgerReconciliationSummary> {
    const raw = await this.manager.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 0) AS total_credits,
        COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 0) AS total_debits,
        COUNT(*)::int as count
      FROM wallet_ledger_entries
      WHERE wallet_id = $1
    `,
      [walletId],
    );

    const row = raw[0] ?? { total_credits: '0.00', total_debits: '0.00', count: 0 };
    return {
      totalCredits: String(row.total_credits),
      totalDebits: String(row.total_debits),
      count: Number(row.count),
    };
  }
}
