import { OutboxMessage } from '../../domain/messaging/outbox-message.entity.js';

export const OUTBOX_REPOSITORY_PORT = Symbol('OUTBOX_REPOSITORY_PORT');

export interface OutboxRepositoryPort {
  save(message: OutboxMessage): Promise<void>;
  fetchDueMessages(limit: number): Promise<OutboxMessage[]>;
  update(message: OutboxMessage): Promise<void>;
}
