import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { InboxMessage } from '../../../domain/messaging/inbox-message.entity.js';

@Entity({ name: 'inbox_messages' })
export class InboxMessageOrmEntity {
  @PrimaryColumn({ name: 'consumer_name', type: 'varchar', length: 64 })
  consumerName!: string;

  @PrimaryColumn({ name: 'message_id', type: 'varchar', length: 128 })
  messageId!: string;

  @Column({ name: 'payload_hash', type: 'varchar', length: 64 })
  payloadHash!: string;

  @CreateDateColumn({ name: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt?: Date | null;

  public toDomain(): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: this.consumerName,
      messageId: this.messageId,
      payloadHash: this.payloadHash,
      receivedAt: this.receivedAt,
      processedAt: this.processedAt ?? undefined,
    });
  }

  public static fromDomain(inbox: InboxMessage): InboxMessageOrmEntity {
    const entity = new InboxMessageOrmEntity();
    entity.consumerName = inbox.consumerName;
    entity.messageId = inbox.messageId;
    entity.payloadHash = inbox.payloadHash;
    entity.receivedAt = inbox.receivedAt;
    entity.processedAt = inbox.processedAt ?? null;
    return entity;
  }
}
