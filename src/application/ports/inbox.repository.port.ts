import { InboxMessage } from '../../domain/messaging/inbox-message.entity.js';

export const INBOX_REPOSITORY_PORT = Symbol('INBOX_REPOSITORY_PORT');

export interface InboxRepositoryPort {
  exists(consumerName: string, messageId: string): Promise<boolean>;
  save(message: InboxMessage): Promise<void>;
}
