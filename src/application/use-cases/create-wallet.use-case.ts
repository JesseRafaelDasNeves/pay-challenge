import { Inject, Injectable, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { UNIT_OF_WORK_PORT, type UnitOfWorkPort } from '../ports/unit-of-work.port.js';
import { WALLET_REPOSITORY_PORT, type WalletRepositoryPort } from '../ports/wallet.repository.port.js';
import { Money } from '../../domain/shared/money.value-object.js';
import { Wallet } from '../../domain/wallet/wallet.aggregate.js';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger.entity.js';
import { LedgerDirection } from '../../domain/wallet/ledger-direction.enum.js';
import { WagerTransaction } from '../../domain/wagering/wager-transaction.aggregate.js';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind.enum.js';
import { computePayloadHash } from '../../domain/shared/canonical-json.util.js';
import {
  WalletBalanceChanged,
  WagerTransactionProcessed,
} from '../../domain/messaging/integration-event.abstract.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.entity.js';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: {
    amount: string;
    currency: string;
  };
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: {
    amount: string;
    currency: string;
  };
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK_PORT)
    private readonly unitOfWork: UnitOfWorkPort,
    @Inject(WALLET_REPOSITORY_PORT)
    private readonly walletRepository: WalletRepositoryPort,
  ) {}

  public async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    const initialMoney = Money.from(command.initialBalance);

    // Validação de unicidade por player + currency
    const existing = await this.walletRepository.findByPlayerIdAndCurrency(
      command.playerId,
      initialMoney.currency,
    );
    if (existing) {
      throw new ConflictException(
        `Já existe uma carteira cadastrada para o jogador ${command.playerId} na moeda ${initialMoney.currency}.`,
      );
    }

    const walletId = randomUUID();
    const now = new Date();
    const wallet = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance: initialMoney,
      createdAt: now,
    });

    await this.unitOfWork.executeInTransaction(async (ctx) => {
      await ctx.wallets.save(wallet);

      // Se houver saldo inicial > 0, cria transação interna OPENING e ledger CREDIT na mesma transação SQL
      if (initialMoney.isPositive()) {
        const openingTxId = randomUUID();
        const idempotencyKey = `internal:opening:${walletId}`;
        const payloadHash = computePayloadHash({
          walletId,
          playerId: command.playerId,
          kind: WagerTransactionKind.Opening,
          amount: initialMoney.amount,
          currency: initialMoney.currency,
        });

        const openingTx = WagerTransaction.create({
          id: openingTxId,
          providerId: 'INTERNAL',
          externalTransactionId: openingTxId,
          idempotencyKey,
          payloadHash,
          walletId,
          playerId: command.playerId,
          roundId: 'OPENING',
          gameId: 'INTERNAL',
          kind: WagerTransactionKind.Opening,
          money: initialMoney,
          createdAt: now,
        });
        openingTx.markProcessed(undefined, now);
        await ctx.transactions.save(openingTx);

        const ledgerEntry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId,
          transactionId: openingTxId,
          direction: LedgerDirection.Credit,
          money: initialMoney,
          balanceBefore: Money.zero(initialMoney.currency),
          balanceAfter: initialMoney,
          createdAt: now,
        });
        await ctx.ledgers.save(ledgerEntry);

        // Eventos de integração
        const correlationId = randomUUID();
        const balanceEvent = new WalletBalanceChanged({
          eventId: randomUUID(),
          aggregateId: walletId,
          correlationId,
          occurredAt: now,
          data: {
            walletId,
            transactionId: openingTxId,
            direction: LedgerDirection.Credit,
            money: initialMoney.toJSON(),
            balanceBefore: Money.zero(initialMoney.currency).toJSON(),
            balanceAfter: initialMoney.toJSON(),
            walletVersion: wallet.version,
          },
        });
        const processedEvent = new WagerTransactionProcessed({
          eventId: randomUUID(),
          aggregateId: openingTxId,
          correlationId,
          occurredAt: now,
          data: {
            transactionId: openingTxId,
            providerId: 'INTERNAL',
            externalTransactionId: openingTxId,
            walletId,
            playerId: command.playerId,
            roundId: 'OPENING',
            gameId: 'INTERNAL',
            kind: WagerTransactionKind.Opening,
            money: initialMoney.toJSON(),
          },
        });

        await ctx.outbox.save(OutboxMessage.enqueue(balanceEvent));
        await ctx.outbox.save(OutboxMessage.enqueue(processedEvent));
      }
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
