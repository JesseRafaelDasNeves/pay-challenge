import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ReprocessPendingReferencesUseCase } from '../../../application/use-cases/reprocess-pending-references.use-case.js';
import {
  METRICS_COLLECTOR_PORT,
  type MetricsCollectorPort,
} from '../../../application/ports/metrics-collector.port.js';

@Injectable()
export class PendingReferencesJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferencesJob.name);
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    private readonly reprocessUseCase: ReprocessPendingReferencesUseCase,
    @Optional()
    @Inject(METRICS_COLLECTOR_PORT)
    private readonly metrics?: MetricsCollectorPort,
  ) {}

  public onModuleInit(): void {
    // Polling a cada 5 segundos para verificar referências resolvidas
    this.timer = setInterval(() => {
      void this.poll();
    }, 5000);
  }

  public onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const processed = await this.reprocessUseCase.execute(20);
      if (processed > 0) {
        for (let i = 0; i < processed; i++) {
          this.metrics?.recordRetry('pending_reference');
        }
        this.logger.log(
          JSON.stringify({
            event: 'PENDING_REFERENCES_REPROCESSED',
            processedCount: processed,
          }),
        );
      }
    } catch (error) {
      this.logger.error('Erro no ciclo de reprocessamento de referências pendentes:', error);
    } finally {
      this.isProcessing = false;
    }
  }
}
