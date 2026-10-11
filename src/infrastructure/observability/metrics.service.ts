import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MetricsCollectorPort } from '../../application/ports/metrics-collector.port.js';
import { SqsPublisherService } from '../messaging/sqs/sqs-publisher.service.js';
import { envConfig } from '../config/env.config.js';

export interface LatencyStats {
  count: number;
  min: number;
  avg: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface MetricsSnapshot {
  timestamp: string;
  uptimeSeconds: number;
  transactions: {
    byStatus: Record<string, number>;
    total: number;
  };
  idempotency: {
    duplicatesDetected: number;
  };
  concurrency: {
    lockConflicts: number;
  };
  retries: {
    sqsConsumerRetries: number;
    outboxRetries: number;
    pendingReferencesRetries: number;
    total: number;
  };
  messaging: {
    dlq: {
      approximateNumberOfMessages: number;
      approximateNumberOfMessagesNotVisible: number;
      status: string;
    };
    outboxLag: {
      pendingCount: number;
      oldestPendingAgeSeconds: number;
    };
  };
  latency: {
    transactionProcessingMs: LatencyStats;
  };
}

@Injectable()
export class MetricsService implements MetricsCollectorPort {
  private readonly logger = new Logger(MetricsService.name);
  private readonly sqsClient?: SQSClient;

  // Contadores em memória
  private readonly transactionsByStatus: Map<string, number> = new Map([
    ['PROCESSED', 0],
    ['REJECTED', 0],
    ['FAILED', 0],
    ['PENDING_REFERENCE', 0],
    ['PENDING', 0],
  ]);

  private duplicatesDetected = 0;
  private lockConflicts = 0;
  private sqsRetries = 0;
  private outboxRetries = 0;
  private pendingReferencesRetries = 0;

  // Amostras de latência (janela deslizante de no máximo 5000 amostras)
  private readonly latenciesMs: number[] = [];
  private readonly maxLatencySamples = 5000;

  constructor(
    @Optional() private readonly dataSource?: DataSource,
    @Optional() private readonly sqsPublisher?: SqsPublisherService,
  ) {
    if (this.sqsPublisher) {
      this.sqsClient = this.sqsPublisher.getClient();
    }
  }

  // --- Implementação da interface MetricsCollectorPort ---

  public recordTransaction(status: string, durationMs: number): void {
    const current = this.transactionsByStatus.get(status) ?? 0;
    this.transactionsByStatus.set(status, current + 1);

    if (durationMs >= 0) {
      this.latenciesMs.push(durationMs);
      if (this.latenciesMs.length > this.maxLatencySamples) {
        this.latenciesMs.shift();
      }
    }
  }

  public recordDuplicateDetected(): void {
    this.duplicatesDetected++;
  }

  public recordLockConflict(): void {
    this.lockConflicts++;
  }

  public recordRetry(type: 'outbox' | 'sqs' | 'pending_reference'): void {
    switch (type) {
      case 'outbox':
        this.outboxRetries++;
        break;
      case 'sqs':
        this.sqsRetries++;
        break;
      case 'pending_reference':
        this.pendingReferencesRetries++;
        break;
    }
  }

  // --- Métricas agregadas e Snapshot consolidado ---

  public async getSnapshot(): Promise<MetricsSnapshot> {
    const [txByStatus, outboxLag, dlqMetrics] = await Promise.all([
      this.fetchTransactionsByStatus(),
      this.fetchOutboxLag(),
      this.fetchDlqMetrics(),
    ]);

    const totalTx = Object.values(txByStatus).reduce((acc, count) => acc + count, 0);

    return {
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime() * 10) / 10,
      transactions: {
        byStatus: txByStatus,
        total: totalTx,
      },
      idempotency: {
        duplicatesDetected: this.duplicatesDetected,
      },
      concurrency: {
        lockConflicts: this.lockConflicts,
      },
      retries: {
        sqsConsumerRetries: this.sqsRetries,
        outboxRetries: this.outboxRetries,
        pendingReferencesRetries: this.pendingReferencesRetries,
        total: this.sqsRetries + this.outboxRetries + this.pendingReferencesRetries,
      },
      messaging: {
        dlq: dlqMetrics,
        outboxLag,
      },
      latency: {
        transactionProcessingMs: this.calculateLatencyStats(),
      },
    };
  }

  public async getTransactionMetrics(): Promise<{
    byStatus: Record<string, number>;
    duplicatesDetected: number;
    lockConflicts: number;
  }> {
    const byStatus = await this.fetchTransactionsByStatus();
    return {
      byStatus,
      duplicatesDetected: this.duplicatesDetected,
      lockConflicts: this.lockConflicts,
    };
  }

  public async getMessagingMetrics(): Promise<{
    dlq: {
      approximateNumberOfMessages: number;
      approximateNumberOfMessagesNotVisible: number;
      status: string;
    };
    outboxLag: {
      pendingCount: number;
      oldestPendingAgeSeconds: number;
    };
    retries: {
      sqs: number;
      outbox: number;
      pendingReferences: number;
    };
  }> {
    const [dlq, outboxLag] = await Promise.all([
      this.fetchDlqMetrics(),
      this.fetchOutboxLag(),
    ]);

    return {
      dlq,
      outboxLag,
      retries: {
        sqs: this.sqsRetries,
        outbox: this.outboxRetries,
        pendingReferences: this.pendingReferencesRetries,
      },
    };
  }

  public getLatencyMetrics(): LatencyStats {
    return this.calculateLatencyStats();
  }

  public async getPrometheusFormat(): Promise<string> {
    const snapshot = await this.getSnapshot();
    const lines: string[] = [
      '# HELP process_uptime_seconds Tempo em segundos desde que a aplicacao iniciou.',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${snapshot.uptimeSeconds}`,
      '',
      '# HELP wagering_transactions_total Total de transacoes processadas agrupadas por status.',
      '# TYPE wagering_transactions_total counter',
    ];

    for (const [status, count] of Object.entries(snapshot.transactions.byStatus)) {
      lines.push(`wagering_transactions_total{status="${status}"} ${count}`);
    }

    lines.push(
      '',
      '# HELP wagering_duplicates_detected_total Total de tentativas duplicadas detectadas via idempotencia.',
      '# TYPE wagering_duplicates_detected_total counter',
      `wagering_duplicates_detected_total ${snapshot.idempotency.duplicatesDetected}`,
      '',
      '# HELP wagering_lock_conflicts_total Total de colisoes ou conflitos de concorrencia na wallet.',
      '# TYPE wagering_lock_conflicts_total counter',
      `wagering_lock_conflicts_total ${snapshot.concurrency.lockConflicts}`,
      '',
      '# HELP wagering_retries_total Total de retentativas executadas pelo sistema.',
      '# TYPE wagering_retries_total counter',
      `wagering_retries_total{component="sqs_consumer"} ${snapshot.retries.sqsConsumerRetries}`,
      `wagering_retries_total{component="outbox_publisher"} ${snapshot.retries.outboxRetries}`,
      `wagering_retries_total{component="pending_references"} ${snapshot.retries.pendingReferencesRetries}`,
      '',
      '# HELP wagering_dlq_messages Total aproximado de mensagens na fila DLQ.',
      '# TYPE wagering_dlq_messages gauge',
      `wagering_dlq_messages{type="visible"} ${snapshot.messaging.dlq.approximateNumberOfMessages}`,
      `wagering_dlq_messages{type="not_visible"} ${snapshot.messaging.dlq.approximateNumberOfMessagesNotVisible}`,
      '',
      '# HELP wagering_outbox_pending_messages Total de mensagens pendentes na outbox.',
      '# TYPE wagering_outbox_pending_messages gauge',
      `wagering_outbox_pending_messages ${snapshot.messaging.outboxLag.pendingCount}`,
      '',
      '# HELP wagering_outbox_lag_seconds Idade em segundos da mensagem mais antiga pendente na outbox.',
      '# TYPE wagering_outbox_lag_seconds gauge',
      `wagering_outbox_lag_seconds ${snapshot.messaging.outboxLag.oldestPendingAgeSeconds}`,
      '',
      '# HELP wagering_processing_latency_ms Latencia de processamento de transacoes em milissegundos.',
      '# TYPE wagering_processing_latency_ms summary',
      `wagering_processing_latency_ms{quantile="0.5"} ${snapshot.latency.transactionProcessingMs.p50}`,
      `wagering_processing_latency_ms{quantile="0.95"} ${snapshot.latency.transactionProcessingMs.p95}`,
      `wagering_processing_latency_ms{quantile="0.99"} ${snapshot.latency.transactionProcessingMs.p99}`,
      `wagering_processing_latency_ms_avg ${snapshot.latency.transactionProcessingMs.avg}`,
      `wagering_processing_latency_ms_count ${snapshot.latency.transactionProcessingMs.count}`,
      '',
    );

    return lines.join('\n');
  }

  // --- Métodos Auxiliares Privados ---

  private async fetchTransactionsByStatus(): Promise<Record<string, number>> {
    // Começa com a contagem base em memória
    const result: Record<string, number> = {};
    for (const [status, count] of this.transactionsByStatus.entries()) {
      result[status] = count;
    }

    if (!this.dataSource || !this.dataSource.isInitialized) {
      return result;
    }

    try {
      const rows: Array<{ status: string; count: string | number }> = await this.dataSource.query(
        'SELECT status, COUNT(*)::int AS count FROM wager_transactions GROUP BY status;',
      );

      for (const row of rows) {
        result[row.status] = Number(row.count);
      }
    } catch (error) {
      this.logger.warn(`Falha ao consultar transações por status no banco: ${error}`);
    }

    return result;
  }

  private async fetchOutboxLag(): Promise<{ pendingCount: number; oldestPendingAgeSeconds: number }> {
    if (!this.dataSource || !this.dataSource.isInitialized) {
      return { pendingCount: 0, oldestPendingAgeSeconds: 0 };
    }

    try {
      const rows: Array<{ pending_count: string | number; oldest_pending_age_seconds: string | number }> =
        await this.dataSource.query(
          `SELECT 
             COUNT(*)::int AS pending_count,
             COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(occurred_at))), 0)::float AS oldest_pending_age_seconds 
           FROM outbox_messages 
           WHERE published_at IS NULL;`,
        );

      if (rows && rows.length > 0) {
        return {
          pendingCount: Number(rows[0].pending_count) || 0,
          oldestPendingAgeSeconds: Math.round(Number(rows[0].oldest_pending_age_seconds) * 10) / 10,
        };
      }
    } catch (error) {
      this.logger.warn(`Falha ao calcular outbox lag: ${error}`);
    }

    return { pendingCount: 0, oldestPendingAgeSeconds: 0 };
  }

  private async fetchDlqMetrics(): Promise<{
    approximateNumberOfMessages: number;
    approximateNumberOfMessagesNotVisible: number;
    status: string;
  }> {
    if (!this.sqsClient) {
      return {
        approximateNumberOfMessages: 0,
        approximateNumberOfMessagesNotVisible: 0,
        status: 'not_configured',
      };
    }

    try {
      const response = await this.sqsClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: envConfig.sqs.dlqUrl,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );

      const visible = Number(response.Attributes?.['ApproximateNumberOfMessages'] ?? 0);
      const notVisible = Number(response.Attributes?.['ApproximateNumberOfMessagesNotVisible'] ?? 0);

      return {
        approximateNumberOfMessages: visible,
        approximateNumberOfMessagesNotVisible: notVisible,
        status: 'connected',
      };
    } catch (error) {
      this.logger.warn(`Falha ao consultar métricas da DLQ no SQS: ${error}`);
      return {
        approximateNumberOfMessages: 0,
        approximateNumberOfMessagesNotVisible: 0,
        status: `unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  public calculateLatencyStats(): LatencyStats {
    if (this.latenciesMs.length === 0) {
      return { count: 0, min: 0, avg: 0, max: 0, p50: 0, p95: 0, p99: 0 };
    }

    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((acc, val) => acc + val, 0);
    const min = sorted[0];
    const max = sorted[count - 1];
    const avg = Math.round((sum / count) * 10) / 10;

    const percentile = (p: number) => {
      const idx = Math.min(Math.floor((p / 100) * count), count - 1);
      return Math.round(sorted[idx] * 10) / 10;
    };

    return {
      count,
      min: Math.round(min * 10) / 10,
      avg,
      max: Math.round(max * 10) / 10,
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
    };
  }
}
