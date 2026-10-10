import { EntityManager } from 'typeorm';
import { OutboxRepositoryPort } from '../../../application/ports/outbox.repository.port.js';
import { OutboxMessage } from '../../../domain/messaging/outbox-message.entity.js';
import { OutboxMessageOrmEntity } from '../entities/outbox-message.orm-entity.js';

export class TypeOrmOutboxRepository implements OutboxRepositoryPort {
  constructor(private readonly manager: EntityManager) {}

  public async save(message: OutboxMessage): Promise<void> {
    const entity = OutboxMessageOrmEntity.fromDomain(message);
    await this.manager.save(OutboxMessageOrmEntity, entity);
  }

  public async fetchDueMessages(limit: number): Promise<OutboxMessage[]> {
    // Consulta atômica com FOR UPDATE SKIP LOCKED para paralelismo seguro entre réplicas
    const rawList = await this.manager.query(
      `
      SELECT
        id,
        aggregate_id,
        event_type,
        payload,
        occurred_at,
        attempts,
        next_attempt_at,
        published_at,
        last_error,
        created_at
      FROM outbox_messages
      WHERE published_at IS NULL
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ORDER BY occurred_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `,
      [limit],
    );

    return (rawList as Array<Record<string, unknown>>).map((row) => {
      return OutboxMessage.rehydrate({
        id: String(row.id),
        aggregateId: String(row.aggregate_id),
        eventType: String(row.event_type),
        payload: (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<
          string,
          unknown
        >,
        occurredAt: new Date(row.occurred_at as string | number),
        attempts: Number(row.attempts),
        nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at as string | number) : undefined,
        publishedAt: row.published_at ? new Date(row.published_at as string | number) : undefined,
        lastError: row.last_error ? String(row.last_error) : undefined,
        createdAt: new Date(row.created_at as string | number),
      });
    });
  }

  public async update(message: OutboxMessage): Promise<void> {
    await this.manager.update(
      OutboxMessageOrmEntity,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? null,
        publishedAt: message.publishedAt ?? null,
        lastError: message.lastError ?? null,
      },
    );
  }
}
