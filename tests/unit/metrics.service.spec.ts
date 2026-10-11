import { describe, expect, it } from 'bun:test';
import { MetricsService } from '../../src/infrastructure/observability/metrics.service.js';

describe('MetricsService Unit Tests', () => {
  it('deve registrar transações e calcular latências com percentis p50, p95 e p99', () => {
    const service = new MetricsService();

    // Registra 10 transações com latências de 10 a 100ms
    for (let i = 1; i <= 10; i++) {
      service.recordTransaction('PROCESSED', i * 10);
    }

    const latency = service.getLatencyMetrics();
    expect(latency.count).toBe(10);
    expect(latency.min).toBe(10);
    expect(latency.max).toBe(100);
    expect(latency.avg).toBe(55);
    expect(latency.p50).toBe(60); // index 5 -> 60
    expect(latency.p95).toBe(100);
    expect(latency.p99).toBe(100);
  });

  it('deve retornar zeros para latência quando não houver amostras', () => {
    const service = new MetricsService();
    const latency = service.getLatencyMetrics();

    expect(latency.count).toBe(0);
    expect(latency.min).toBe(0);
    expect(latency.avg).toBe(0);
    expect(latency.max).toBe(0);
    expect(latency.p50).toBe(0);
    expect(latency.p95).toBe(0);
    expect(latency.p99).toBe(0);
  });

  it('deve registrar e contabilizar duplicatas detectadas', () => {
    const service = new MetricsService();

    service.recordDuplicateDetected();
    service.recordDuplicateDetected();

    const latency = service.calculateLatencyStats();
    expect(latency.count).toBe(0);
  });

  it('deve registrar e contabilizar retries por componente', async () => {
    const service = new MetricsService();

    service.recordRetry('outbox');
    service.recordRetry('outbox');
    service.recordRetry('sqs');
    service.recordRetry('pending_reference');

    const messaging = await service.getMessagingMetrics();
    expect(messaging.retries.outbox).toBe(2);
    expect(messaging.retries.sqs).toBe(1);
    expect(messaging.retries.pendingReferences).toBe(1);
  });

  it('deve registrar e contabilizar conflitos de lock', async () => {
    const service = new MetricsService();

    service.recordLockConflict();
    service.recordLockConflict();
    service.recordLockConflict();

    const txMetrics = await service.getTransactionMetrics();
    expect(txMetrics.lockConflicts).toBe(3);
  });

  it('deve gerar snapshot consolidado completo mesmo sem banco inicializado', async () => {
    const service = new MetricsService();

    service.recordTransaction('PROCESSED', 15);
    service.recordTransaction('REJECTED', 5);
    service.recordDuplicateDetected();
    service.recordLockConflict();
    service.recordRetry('outbox');

    const snapshot = await service.getSnapshot();

    expect(snapshot.timestamp).toBeDefined();
    expect(snapshot.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(snapshot.transactions.byStatus['PROCESSED']).toBe(1);
    expect(snapshot.transactions.byStatus['REJECTED']).toBe(1);
    expect(snapshot.idempotency.duplicatesDetected).toBe(1);
    expect(snapshot.concurrency.lockConflicts).toBe(1);
    expect(snapshot.retries.outboxRetries).toBe(1);
    expect(snapshot.retries.total).toBe(1);
    expect(snapshot.latency.transactionProcessingMs.count).toBe(2);
  });

  it('deve formatar métricas no padrão Prometheus com headers de HELP e TYPE', async () => {
    const service = new MetricsService();

    service.recordTransaction('PROCESSED', 20);
    service.recordDuplicateDetected();
    service.recordLockConflict();
    service.recordRetry('sqs');

    const prometheus = await service.getPrometheusFormat();

    expect(prometheus).toContain('# HELP process_uptime_seconds');
    expect(prometheus).toContain('# TYPE process_uptime_seconds gauge');
    expect(prometheus).toContain('wagering_transactions_total{status="PROCESSED"} 1');
    expect(prometheus).toContain('wagering_duplicates_detected_total 1');
    expect(prometheus).toContain('wagering_lock_conflicts_total 1');
    expect(prometheus).toContain('wagering_retries_total{component="sqs_consumer"} 1');
    expect(prometheus).toContain('wagering_processing_latency_ms{quantile="0.5"} 20');
  });
});
