import { IntegrationEvent } from './integration-event.abstract.js';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
  lastError?: string;
  createdAt: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
    private _lastError?: string,
    public readonly createdAt?: Date,
  ) {}

  public static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const serialized = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      serialized as unknown as Record<string, unknown>,
      event.occurredAt,
      0, // attempts = 0
      undefined,
      undefined,
      undefined,
      new Date(),
    );
  }

  public static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
      state.createdAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  public isPending(): boolean {
    return !this._publishedAt;
  }

  public isDue(now: Date = new Date()): boolean {
    if (this._publishedAt) {
      return false;
    }
    if (!this._nextAttemptAt) {
      return true;
    }
    return this._nextAttemptAt <= now;
  }

  public markPublished(at: Date = new Date()): void {
    this._publishedAt = at;
    this._lastError = undefined;
  }

  public scheduleRetry(now: Date = new Date(), error?: string): void {
    this._attempts += 1;
    this._lastError = error;
    // Backoff exponencial simples: 2^attempts segundos (ex: 2s, 4s, 8s, máx 60s)
    const backoffSeconds = Math.min(60, Math.pow(2, this._attempts));
    this._nextAttemptAt = new Date(now.getTime() + backoffSeconds * 1000);
  }
}
