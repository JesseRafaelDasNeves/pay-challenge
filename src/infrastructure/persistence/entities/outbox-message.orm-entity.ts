import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { OutboxMessage } from '../../../domain/messaging/outbox-message.entity.js';

@Entity({ name: 'outbox_messages' })
export class OutboxMessageOrmEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'aggregate_id', type: 'varchar', length: 64 })
  aggregateId!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 128 })
  eventType!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt?: Date | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt?: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  public toDomain(): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      payload: this.payload,
      occurredAt: this.occurredAt,
      attempts: this.attempts,
      nextAttemptAt: this.nextAttemptAt ?? undefined,
      publishedAt: this.publishedAt ?? undefined,
      lastError: this.lastError ?? undefined,
      createdAt: this.createdAt,
    });
  }

  public static fromDomain(outbox: OutboxMessage): OutboxMessageOrmEntity {
    const entity = new OutboxMessageOrmEntity();
    entity.id = outbox.id;
    entity.aggregateId = outbox.aggregateId;
    entity.eventType = outbox.eventType;
    entity.payload = outbox.payload as Record<string, unknown>;
    entity.occurredAt = outbox.occurredAt;
    entity.attempts = outbox.attempts;
    entity.nextAttemptAt = outbox.nextAttemptAt ?? null;
    entity.publishedAt = outbox.publishedAt ?? null;
    entity.lastError = outbox.lastError ?? null;
    entity.createdAt = outbox.createdAt ?? new Date();
    return entity;
  }
}
