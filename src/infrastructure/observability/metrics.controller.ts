import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service.js';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get()
  public async getMetrics() {
    return this.metricsService.getSnapshot();
  }

  @Get('transactions')
  public async getTransactions() {
    return this.metricsService.getTransactionMetrics();
  }

  @Get('messaging')
  public async getMessaging() {
    return this.metricsService.getMessagingMetrics();
  }

  @Get('latency')
  public getLatency() {
    return this.metricsService.getLatencyMetrics();
  }

  @Get('prometheus')
  public async getPrometheus(@Res() res: Response) {
    const rawMetrics = await this.metricsService.getPrometheusFormat();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return res.status(200).send(rawMetrics);
  }
}
