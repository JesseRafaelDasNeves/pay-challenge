import { describe, expect, it } from 'bun:test';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction.aggregate.js';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind.enum.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status.enum.js';
import { FailureCode } from '../../src/domain/wagering/failure-code.enum.js';
import { Money } from '../../src/domain/shared/money.value-object.js';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction.enum.js';

describe('WagerTransaction Aggregate', () => {
  const defaultProps = {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-100',
    idempotencyKey: 'key-1',
    payloadHash: 'hash-abc',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '50.00', currency: 'BRL' }),
  };

  it('deve nascer no status PENDING', () => {
    const tx = WagerTransaction.create(defaultProps);
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
  });

  it('deve transicionar para PROCESSED com sucesso', () => {
    const tx = WagerTransaction.create(defaultProps);
    tx.markProcessed(undefined, new Date());

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.isTerminal()).toBe(true);
    expect(tx.processedAt).toBeDefined();
  });

  it('deve transicionar para REJECTED com código de falha', () => {
    const tx = WagerTransaction.create(defaultProps);
    tx.reject(FailureCode.InsufficientFunds);

    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.isTerminal()).toBe(true);
  });

  it('deve lançar erro ao tentar alterar o estado de uma transação já em estado terminal', () => {
    const tx = WagerTransaction.create(defaultProps);
    tx.markProcessed();

    expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow('Transição inválida');
    expect(() => tx.markProcessed()).toThrow('Transição inválida');
  });

  it('deve exigir referenceExternalTransactionId para operações REFUND e ROLLBACK', () => {
    expect(() =>
      WagerTransaction.create({
        ...defaultProps,
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: undefined,
      }),
    ).toThrow('Operações do tipo REFUND exigem referenceExternalTransactionId');

    expect(() =>
      WagerTransaction.create({
        ...defaultProps,
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: undefined,
      }),
    ).toThrow('Operações do tipo ROLLBACK exigem referenceExternalTransactionId');
  });

  it('deve indicar corretamente se afeta saldo', () => {
    const betTx = WagerTransaction.create(defaultProps);
    expect(betTx.affectsBalance()).toBe(true);

    const lossTx = WagerTransaction.create({ ...defaultProps, kind: WagerTransactionKind.Loss });
    expect(lossTx.affectsBalance()).toBe(false);
  });

  it('deve calcular corretamente a direção do ledger para Rollback', () => {
    const rollbackTx = WagerTransaction.create({
      ...defaultProps,
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-bet',
    });

    const refBet = WagerTransaction.create({
      ...defaultProps,
      kind: WagerTransactionKind.Bet,
    });
    const refWin = WagerTransaction.create({
      ...defaultProps,
      kind: WagerTransactionKind.Win,
    });

    // Rollback de BET (que foi débito) resulta em crédito
    expect(rollbackTx.ledgerDirectionFor(refBet)).toBe(LedgerDirection.Credit);
    // Rollback de WIN (que foi crédito) resulta em débito
    expect(rollbackTx.ledgerDirectionFor(refWin)).toBe(LedgerDirection.Debit);
  });
});
