import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import {
  OUTBOX_REPOSITORY_PORT,
  type OutboxRepositoryPort,
} from '../../../application/ports/outbox.repository.port.js';
import {
  METRICS_COLLECTOR_PORT,
  type MetricsCollectorPort,
} from '../../../application/ports/metrics-collector.port.js';
import { SqsPublisherService } from '../sqs/sqs-publisher.service.js';
import { envConfig } from '../../config/env.config.js';

@Injectable()
export class OutboxPublisherJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherJob.name);
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private isShuttingDown = false;

  constructor(
    @Inject(OUTBOX_REPOSITORY_PORT)
    private readonly outboxRepository: OutboxRepositoryPort,
    private readonly sqsPublisher: SqsPublisherService,
    @Optional()
    @Inject(METRICS_COLLECTOR_PORT)
    private readonly metrics?: MetricsCollectorPort,
  ) {}

  public onModuleInit(): void {
    // Polling a cada 1000ms
    this.timer = setInterval(() => {
      void this.processDueMessages();
    }, 1000);
  }

  public onModuleDestroy(): void {
    this.isShuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async processDueMessages(): Promise<number> {
    if (this.isProcessing || this.isShuttingDown) {
      return 0;
    }

    this.isProcessing = true;
    let publishedCount = 0;

    try {
      // Busca mensagens prontas com lock pessimista SKIP LOCKED no PostgreSQL
      const messages = await this.outboxRepository.fetchDueMessages(50);

      for (const msg of messages) {
        if (this.isShuttingDown) break;

        try {
          const body = JSON.stringify(msg.payload);
          await this.sqsPublisher.publish(
            envConfig.sqs.queueUrl,
            body,
            msg.aggregateId,
            msg.id, // ID único para deduplicação no FIFO
          );

          msg.markPublished(new Date());
          await this.outboxRepository.update(msg);
          publishedCount++;

          this.logger.log(
            JSON.stringify({
              event: 'OUTBOX_MESSAGE_PUBLISHED',
              outboxId: msg.id,
              aggregateId: msg.aggregateId,
              eventType: msg.eventType,
            }),
          );
        } catch (error: any) {
          this.metrics?.recordRetry('outbox');
          this.logger.warn(
            JSON.stringify({
              event: 'OUTBOX_MESSAGE_PUBLISH_FAILED',
              outboxId: msg.id,
              aggregateId: msg.aggregateId,
              attempts: msg.attempts + 1,
              error: error?.message || String(error),
            }),
          );
          msg.scheduleRetry(new Date(), error?.message || String(error));
          await this.outboxRepository.update(msg);
        }
      }
    } catch (error) {
      this.logger.error('Erro no ciclo de polling do OutboxPublisherJob:', error);
    } finally {
      this.isProcessing = false;
    }

    return publishedCount;
  }
}
