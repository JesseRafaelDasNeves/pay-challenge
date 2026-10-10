import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ReprocessPendingReferencesUseCase } from '../../../application/use-cases/reprocess-pending-references.use-case.js';

@Injectable()
export class PendingReferencesJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferencesJob.name);
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(private readonly reprocessUseCase: ReprocessPendingReferencesUseCase) {}

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
        this.logger.log(`Reprocessadas ${processed} transações que aguardavam referência.`);
      }
    } catch (error) {
      this.logger.error('Erro no ciclo de reprocessamento de referências pendentes:', error);
    } finally {
      this.isProcessing = false;
    }
  }
}
