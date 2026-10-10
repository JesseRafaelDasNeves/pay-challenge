import { EntityManager } from 'typeorm';
import { InboxRepositoryPort } from '../../../application/ports/inbox.repository.port.js';
import { InboxMessage } from '../../../domain/messaging/inbox-message.entity.js';
import { InboxMessageOrmEntity } from '../entities/inbox-message.orm-entity.js';

export class TypeOrmInboxRepository implements InboxRepositoryPort {
  constructor(private readonly manager: EntityManager) {}

  public async exists(consumerName: string, messageId: string): Promise<boolean> {
    const count = await this.manager.count(InboxMessageOrmEntity, {
      where: { consumerName, messageId },
    });
    return count > 0;
  }

  public async save(message: InboxMessage): Promise<void> {
    const entity = InboxMessageOrmEntity.fromDomain(message);
    await this.manager.save(InboxMessageOrmEntity, entity);
  }
}
