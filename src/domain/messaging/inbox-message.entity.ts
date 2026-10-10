export interface ReceiveInboxProps {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt?: Date;
}

export interface InboxMessageState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(
    public readonly consumerName: string,
    public readonly messageId: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  public static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.consumerName || !props.messageId || !props.payloadHash) {
      throw new Error('Campos obrigatórios ausentes ao registrar InboxMessage.');
    }
    return new InboxMessage(
      props.consumerName,
      props.messageId,
      props.payloadHash,
      props.receivedAt ?? new Date(),
    );
  }

  public static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.consumerName,
      state.messageId,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  public isProcessed(): boolean {
    return !!this._processedAt;
  }

  public markProcessed(at?: Date): void {
    this._processedAt = at ?? new Date();
  }
}
