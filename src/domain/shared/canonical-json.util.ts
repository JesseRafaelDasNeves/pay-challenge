import { createHash } from 'node:crypto';

/**
 * Serializa um objeto em JSON canônico com todas as chaves ordenadas alfabeticamente de forma recursiva.
 */
export function stringifyCanonical(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return `[${obj.map((item) => stringifyCanonical(item)).join(',')}]`;
  }

  const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
  const entries = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${stringifyCanonical((obj as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(',')}}`;
}

/**
 * Calcula o hash SHA-256 do JSON canônico dos dados de negócio de uma transação.
 */
export function computePayloadHash(data: unknown): string {
  const canonicalString = stringifyCanonical(data);
  return createHash('sha256').update(canonicalString).digest('hex');
}
