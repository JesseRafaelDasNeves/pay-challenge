import { EntityManager } from 'typeorm';
import { WagerTransactionRepositoryPort } from '../../../application/ports/wager-transaction.repository.port.js';
import { WagerTransaction } from '../../../domain/wagering/wager-transaction.aggregate.js';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status.enum.js';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity.js';

export class TypeOrmWagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly manager: EntityManager) {}

  public async findById(id: string): Promise<WagerTransaction | null> {
    const entity = await this.manager.findOne(WagerTransactionOrmEntity, { where: { id } });
    return entity ? entity.toDomain() : null;
  }

  public async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const entity = await this.manager.findOne(WagerTransactionOrmEntity, {
      where: { idempotencyKey: key },
    });
    return entity ? entity.toDomain() : null;
  }

  public async findByProviderAndExternalId(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.manager.findOne(WagerTransactionOrmEntity, {
      where: { providerId, externalTransactionId: externalId },
    });
    return entity ? entity.toDomain() : null;
  }

  public async findReferenceTransaction(
    providerId: string,
    referenceExternalId: string,
  ): Promise<WagerTransaction | null> {
    const entity = await this.manager.findOne(WagerTransactionOrmEntity, {
      where: {
        providerId,
        externalTransactionId: referenceExternalId,
      },
    });
    return entity ? entity.toDomain() : null;
  }

  public async save(transaction: WagerTransaction): Promise<void> {
    const entity = WagerTransactionOrmEntity.fromDomain(transaction);
    await this.manager.save(WagerTransactionOrmEntity, entity);
  }

  public async findPendingReferences(limit: number): Promise<WagerTransaction[]> {
    const entities = await this.manager.find(WagerTransactionOrmEntity, {
      where: { status: WagerTransactionStatus.PendingReference },
      order: { createdAt: 'ASC' },
      take: limit,
    });
    return entities.map((e) => e.toDomain());
  }
}
