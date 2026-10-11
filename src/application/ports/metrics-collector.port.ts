export const METRICS_COLLECTOR_PORT = Symbol('METRICS_COLLECTOR_PORT');

export interface MetricsCollectorPort {
  recordTransaction(status: string, durationMs: number): void;
  recordDuplicateDetected(): void;
  recordLockConflict(): void;
  recordRetry(type: 'outbox' | 'sqs' | 'pending_reference'): void;
}
