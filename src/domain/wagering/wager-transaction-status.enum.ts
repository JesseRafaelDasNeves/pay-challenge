export enum WagerTransactionStatus {
  Pending = 'PENDING',                     // Aceita, ainda não aplicada
  PendingReference = 'PENDING_REFERENCE', // Aguardando transação referenciada
  Processed = 'PROCESSED',                 // Aplicada com sucesso (terminal)
  Rejected = 'REJECTED',                   // Violação de regra de negócio (terminal)
  Failed = 'FAILED',                       // Erro permanente de infraestrutura (terminal)
}
