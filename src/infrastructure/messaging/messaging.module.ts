import { Module } from '@nestjs/common';
import { ApplicationModule } from '../../application/application.module.js';
import { SqsPublisherService } from './sqs/sqs-publisher.service.js';
import { SqsConsumerService } from './sqs/sqs-consumer.service.js';
import { OutboxPublisherJob } from './jobs/outbox-publisher.job.js';
import { PendingReferencesJob } from './jobs/pending-references.job.js';

@Module({
  imports: [ApplicationModule],
  providers: [
    SqsPublisherService,
    SqsConsumerService,
    OutboxPublisherJob,
    PendingReferencesJob,
  ],
  exports: [SqsPublisherService],
})
export class MessagingModule {}
