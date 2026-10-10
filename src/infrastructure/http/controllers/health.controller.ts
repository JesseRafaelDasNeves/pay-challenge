import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { DataSource } from 'typeorm';
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SqsPublisherService } from '../../messaging/sqs/sqs-publisher.service.js';
import { envConfig } from '../../config/env.config.js';

@Controller('health')
export class HealthController {
  private readonly sqsClient: SQSClient;

  constructor(
    private readonly dataSource: DataSource,
    private readonly sqsPublisher: SqsPublisherService,
  ) {
    this.sqsClient = this.sqsPublisher.getClient();
  }

  @Get('live')
  public getLive() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  public async getReady(@Res() res: Response) {
    let postgresStatus = 'connected';
    let sqsStatus = 'connected';
    let isHealthy = true;

    // 1. Testa conectividade com PostgreSQL
    try {
      await this.dataSource.query('SELECT 1');
    } catch (error) {
      postgresStatus = `disconnected: ${error instanceof Error ? error.message : String(error)}`;
      isHealthy = false;
    }

    // 2. Testa conectividade com AWS SQS / LocalStack
    try {
      await this.sqsClient.send(
        new GetQueueAttributesCommand({
          QueueUrl: envConfig.sqs.queueUrl,
          AttributeNames: ['ApproximateNumberOfMessages'],
        }),
      );
    } catch (error) {
      sqsStatus = `disconnected: ${error instanceof Error ? error.message : String(error)}`;
      isHealthy = false;
    }

    const httpStatus = isHealthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(httpStatus).json({
      status: isHealthy ? 'ok' : 'error',
      postgres: postgresStatus,
      sqs: sqsStatus,
      timestamp: new Date().toISOString(),
    });
  }
}
