import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service.js';
import { MetricsController } from './metrics.controller.js';
import { METRICS_COLLECTOR_PORT } from '../../application/ports/metrics-collector.port.js';
import { MessagingModule } from '../messaging/messaging.module.js';

@Global()
@Module({
  imports: [MessagingModule],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    {
      provide: METRICS_COLLECTOR_PORT,
      useExisting: MetricsService,
    },
  ],
  exports: [METRICS_COLLECTOR_PORT, MetricsService],
})
export class ObservabilityModule {}
