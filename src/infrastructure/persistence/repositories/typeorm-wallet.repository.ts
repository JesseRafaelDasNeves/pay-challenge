import { EntityManager } from 'typeorm';
import { WalletRepositoryPort } from '../../../application/ports/wallet.repository.port.js';
import { Wallet } from '../../../domain/wallet/wallet.aggregate.js';
import { WalletOrmEntity } from '../entities/wallet.orm-entity.js';

export class TypeOrmWalletRepository implements WalletRepositoryPort {
  constructor(private readonly manager: EntityManager) {}

  public async findById(id: string, lock?: 'pessimistic_write'): Promise<Wallet | null> {
    const findOptions: Parameters<EntityManager['findOne']>[1] = {
      where: { id },
    };

    if (lock === 'pessimistic_write') {
      findOptions.lock = { mode: 'pessimistic_write' };
    }

    const entity = await this.manager.findOne(WalletOrmEntity, findOptions);
    return entity ? entity.toDomain() : null;
  }

  public async findByPlayerIdAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const entity = await this.manager.findOne(WalletOrmEntity, {
      where: { playerId, currency: currency.toUpperCase() },
    });
    return entity ? entity.toDomain() : null;
  }

  public async save(wallet: Wallet): Promise<void> {
    const entity = WalletOrmEntity.fromDomain(wallet);
    await this.manager.save(WalletOrmEntity, entity);
  }
}
