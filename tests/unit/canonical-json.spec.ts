import { describe, expect, it } from 'bun:test';
import { computePayloadHash, stringifyCanonical } from '../../src/domain/shared/canonical-json.util.js';

describe('Canonical JSON Utility', () => {
  it('deve gerar a mesma representação JSON independente da ordem das propriedades', () => {
    const objA = { b: 2, a: 1, c: { y: 'bar', x: 'foo' } };
    const objB = { a: 1, c: { x: 'foo', y: 'bar' }, b: 2 };

    const canonicalA = stringifyCanonical(objA);
    const canonicalB = stringifyCanonical(objB);

    expect(canonicalA).toBe(canonicalB);
    expect(canonicalA).toBe('{"a":1,"b":2,"c":{"x":"foo","y":"bar"}}');
  });

  it('deve gerar o mesmo hash SHA-256 para objetos semanticamente equivalentes', () => {
    const payload1 = {
      providerId: 'provider-a',
      amount: '25.00',
      playerId: 'player-1',
      roundId: 'round-1',
    };

    const payload2 = {
      roundId: 'round-1',
      playerId: 'player-1',
      amount: '25.00',
      providerId: 'provider-a',
    };

    const hash1 = computePayloadHash(payload1);
    const hash2 = computePayloadHash(payload2);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('deve gerar hashes distintos para payloads com qualquer alteração de valor', () => {
    const payload1 = { amount: '25.00', currency: 'BRL' };
    const payload2 = { amount: '25.01', currency: 'BRL' };

    expect(computePayloadHash(payload1)).not.toBe(computePayloadHash(payload2));
  });
});
