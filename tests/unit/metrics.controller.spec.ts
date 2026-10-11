import { describe, expect, it } from 'bun:test';
import { MetricsService } from '../../src/infrastructure/observability/metrics.service.js';
import { MetricsController } from '../../src/infrastructure/observability/metrics.controller.js';

describe('MetricsController Unit Tests', () => {
  it('GET /metrics deve retornar snapshot consolidado', async () => {
    const service = new MetricsService();
    const controller = new MetricsController(service);

    service.recordTransaction('PROCESSED', 12);
    const result = await controller.getMetrics();

    expect(result.transactions.byStatus['PROCESSED']).toBe(1);
    expect(result.latency.transactionProcessingMs.count).toBe(1);
  });

  it('GET /metrics/transactions deve retornar métricas de transações e duplicatas', async () => {
    const service = new MetricsService();
    const controller = new MetricsController(service);

    service.recordTransaction('PROCESSED', 10);
    service.recordDuplicateDetected();
    service.recordLockConflict();

    const result = await controller.getTransactions();

    expect(result.byStatus['PROCESSED']).toBe(1);
    expect(result.duplicatesDetected).toBe(1);
    expect(result.lockConflicts).toBe(1);
  });

  it('GET /metrics/messaging deve retornar métricas de retries e outbox lag', async () => {
    const service = new MetricsService();
    const controller = new MetricsController(service);

    service.recordRetry('outbox');
    service.recordRetry('sqs');

    const result = await controller.getMessaging();

    expect(result.retries.outbox).toBe(1);
    expect(result.retries.sqs).toBe(1);
    expect(result.outboxLag).toBeDefined();
  });

  it('GET /metrics/latency deve retornar estatísticas de latência', () => {
    const service = new MetricsService();
    const controller = new MetricsController(service);

    service.recordTransaction('PROCESSED', 15);
    service.recordTransaction('PROCESSED', 25);

    const result = controller.getLatency();

    expect(result.count).toBe(2);
    expect(result.min).toBe(15);
    expect(result.max).toBe(25);
    expect(result.avg).toBe(20);
  });

  it('GET /metrics/prometheus deve retornar texto formatado com Content-Type adequado', async () => {
    const service = new MetricsService();
    const controller = new MetricsController(service);

    service.recordTransaction('PROCESSED', 30);

    let sentHeader = '';
    let sentStatus = 0;
    let sentBody = '';

    const mockResponse: any = {
      setHeader: (name: string, value: string) => {
        if (name.toLowerCase() === 'content-type') {
          sentHeader = value;
        }
      },
      status: (code: number) => {
        sentStatus = code;
        return {
          send: (body: string) => {
            sentBody = body;
            return body;
          },
        };
      },
    };

    await controller.getPrometheus(mockResponse);

    expect(sentHeader).toContain('text/plain');
    expect(sentStatus).toBe(200);
    expect(sentBody).toContain('wagering_transactions_total');
  });
});
