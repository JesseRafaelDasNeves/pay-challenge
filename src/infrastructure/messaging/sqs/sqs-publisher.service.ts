import { Injectable, Logger } from '@nestjs/common';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { envConfig } from '../../config/env.config.js';

@Injectable()
export class SqsPublisherService {
  private readonly logger = new Logger(SqsPublisherService.name);
  private readonly client: SQSClient;

  constructor() {
    this.client = new SQSClient({
      region: envConfig.sqs.region,
      endpoint: envConfig.sqs.endpoint,
      credentials: {
        accessKeyId: envConfig.sqs.accessKeyId,
        secretAccessKey: envConfig.sqs.secretAccessKey,
      },
    });
  }

  public async publish(
    queueUrl: string,
    body: string,
    messageGroupId?: string,
    messageDeduplicationId?: string,
  ): Promise<string> {
    const isFifo = queueUrl.endsWith('.fifo');
    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: isFifo ? messageGroupId || 'default-group' : undefined,
      MessageDeduplicationId: isFifo ? messageDeduplicationId : undefined,
    });

    const response = await this.client.send(command);
    return response.MessageId || '';
  }

  public getClient(): SQSClient {
    return this.client;
  }
}
