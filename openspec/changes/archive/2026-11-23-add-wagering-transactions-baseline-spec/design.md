# Design

## Context

Este documento registra o desenho arquitetural vigente (*as-is*) da capacidade `wagering-transactions` descrita em `proposal.md` e `specs/wagering-transactions/spec.md`, sem introduzir alterações em código-fonte, testes, contratos HTTP/SQS ou schema SQL. A solução adota Clean Architecture / Arquitetura Hexagonal (Ports & Adapters) + DDD sobre Bun (`bun test`), TypeScript em modo estrito ESM (imports relativos com `.js`), NestJS, TypeORM, PostgreSQL e AWS SQS FIFO (LocalStack).

## Goals / Non-Goals

**Goals:**
- Documentar fielmente o isolamento do domínio de apostas/mensageria (`src/domain/wagering/`, `src/domain/messaging/`, `src/domain/shared/`), os casos de uso dedicados por operação e tipo (`src/application/use-cases/` e `wager-kinds/`), as portas e os adaptadores HTTP, de persistência e de mensageria.
- Registrar os limites transacionais (`UnitOfWorkPort` / `TypeOrmUnitOfWork`), a serialização por `walletId` (`SELECT ... FOR UPDATE`), a resolução de colisões `23505`, o funcionamento real de `SqsConsumerService`, `OutboxPublisherJob` e `PendingReferencesJob`, além das constraints e índices da migration `1700000000000-initial-schema.ts`.
- Formalizar as 9 ressalvas técnicas identificadas na implementação atual para orientar futuras changes de hardening e ampliação de testes.

**Non-Goals:**
- Alterar código de produção (`src/**`), suítes de testes (`tests/**`) ou configurações do OpenSpec.
- Criar novas migrations ou alterar tabelas, índices, constraints e triggers no PostgreSQL.
- Alterar a especificação consolidada `openspec/specs/wallets/spec.md` ou detalhar os endpoints operacionais `/health/**` e `/metrics/**`.

## Decisions

### 1. Isolamento total da camada de domínio (`src/domain/`)
- **Decisão**: Manter `WagerTransaction` (`src/domain/wagering/wager-transaction.aggregate.ts`), `WagerTransactionKind`, `WagerTransactionStatus`, `FailureCode`, `canonical-json.util.ts` (`stringifyCanonical`, `computePayloadHash`), `Money` (`decimal.js`), `IntegrationEvent` (`WalletBalanceChanged`, `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`), `InboxMessage` e `OutboxMessage` 100% livres de decorators ou imports de NestJS, TypeORM ou AWS SDK.
- **Modelagem e invariantes**: Agregados e entidades utilizam construtor `private`/`protected` com factories estáticas explícitas (`create`, `receive`, `enqueue`, `rehydrate`). `WagerTransaction.create` nasce em `PENDING` e exige `referenceExternalTransactionId` para `REFUND` e `ROLLBACK`; `rehydrate` reconstrói estado persistido sem revalidar transições. Métodos de transição (`markProcessed`, `markPendingReference`, `reject`, `fail`) impõem `assertNotTerminal()`, impedindo mudanças após `PROCESSED`, `REJECTED` ou `FAILED`. `ledgerDirectionFor(reference?)` mapeia `BET -> DEBIT`, `WIN`/`OPENING`/`REFUND -> CREDIT` e inverte a direção da referência em `ROLLBACK` (`BET -> CREDIT`, `WIN`/`REFUND -> DEBIT`).
- **Alternativa considerada**: Espalhar regras de transição e cálculo de hash/direção contábil pelos controllers ou entidades ORM. Rejeitada para preservar testabilidade pura em memória e separar o núcleo financeiro da infraestrutura.

### 2. Casos de uso dedicados, composição por tipo e inversão de dependência (SOLID)
- **Decisão**: Cada ponto de entrada e operação possui caso de uso específico em `src/application/use-cases/`:
  - `ProcessWagerTransactionUseCase` (`process-wager-transaction.use-case.ts`): orquestra hash canônico SHA-256, transação SQL, lock de carteira, checagem de idempotência, Inbox (quando origem SQS), despacho via mapa `ReadonlyMap<WagerTransactionKind, WagerTransactionKindUseCase>`, tratamento de colisão `23505`, logs estruturados e métricas via `MetricsCollectorPort`.
  - Handlers especializados por tipo em `src/application/use-cases/wager-kinds/` estendendo `BaseWagerTransactionKindUseCase`: `ProcessBetTransactionUseCase`, `ProcessWinTransactionUseCase`, `ProcessLossTransactionUseCase`, `ProcessRefundTransactionUseCase` e `ProcessRollbackTransactionUseCase`.
  - `GetWagerTransactionUseCase` (`get-wager-transaction.use-case.ts`): consultas dedicadas `getById` e `getByProviderAndExternalId`.
  - `ReprocessPendingReferencesUseCase` (`reprocess-pending-references.use-case.ts`): reavalia transações `PENDING_REFERENCE` em lote e aplica expiração após TTL de 10 minutos.
- **Ports & Adapters**: A camada `application` depende apenas das interfaces/tokens em `src/application/ports/` (`UNIT_OF_WORK_PORT`, `WAGER_TRANSACTION_REPOSITORY_PORT`, `WALLET_REPOSITORY_PORT`, `WALLET_LEDGER_REPOSITORY_PORT`, `INBOX_REPOSITORY_PORT`, `OUTBOX_REPOSITORY_PORT`, `METRICS_COLLECTOR_PORT`), implementados via padrão Data Mapper em `src/infrastructure/persistence/` e `src/infrastructure/observability/`.
- **Fronteira HTTP**: `WageringController` (`src/infrastructure/http/controllers/wagering.controller.ts`) valida `Idempotency-Key`, propaga `X-Correlation-Id` (em conjunto com `LoggingInterceptor`), usa `ValidationPipe` global (`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`, `stopAtFirstError: false`) com `SubmitWagerTransactionDto` (bloqueando `OPENING`), `ParseUUIDPipe` em `:transactionId`, mapeia `status` para HTTP (`200`/`202`/`422`/`500`) e padroniza exceções via `HttpExceptionFilter`.

### 3. Limites transacionais (`UnitOfWork`), lock por `walletId`, Inbox e Outbox
- **Serialização por `walletId`**: Toda execução em `ProcessWagerTransactionUseCase` abre uma transação SQL via `UnitOfWorkPort.executeInTransaction` (`TypeOrmUnitOfWork`) e adquire `SELECT ... FOR UPDATE` (`'pessimistic_write'`) sobre `wallets` via `ctx.wallets.findById(command.walletId, 'pessimistic_write')`. Isso garante leitura da versão mais recente e serializa operações na mesma carteira entre múltiplas instâncias sem lock global entre carteiras distintas.
- **Atomicidade de persistência**: Na mesma transação SQL são persistidos (conforme o desfecho): registro em `inbox_messages` (origem SQS), atualização de saldo/`version` em `wallets`, registro em `wager_transactions`, lançamento imutável em `wallet_ledger_entries` e eventos v1 em `outbox_messages`. Em colisões de chave única (`23505` / `uq_wager_tx*`), o `catch` contabiliza `recordLockConflict()` e abre nova transação de leitura para resolver replay idêntico ou `409 Conflict` (`IDEMPOTENCY_PAYLOAD_MISMATCH`).
- **Transactional Inbox (`SqsConsumerService`)**: Executa long polling em `envConfig.sqs.queueUrl` (`MaxNumberOfMessages = 5`, `WaitTimeSeconds = 5`, `VisibilityTimeout = 30`, pausa `2000ms` em erro de polling, shutdown gracioso em `onModuleDestroy`), valida `SqsWagerMessageDto`, aplica fallback `idempotencyKey = "${providerId}:${externalTransactionId}"`, invoca `ProcessWagerTransactionUseCase` com `consumerName = 'wager-transactions-consumer'` e `consumerMessageId = msg.MessageId || dto.messageId`, e envia `DeleteMessageCommand` **somente após** o commit no PostgreSQL. Mensagens malformadas ou exceções não recebem ACK e seguem a `RedrivePolicy` da fila (`maxReceiveCount = 3` para `wager-transactions-dlq.fifo`).
- **Transactional Outbox (`OutboxPublisherJob` + `SqsPublisherService`)**: Polling a cada `1000ms` (trava `isProcessing`, shutdown gracioso em `onModuleDestroy`) busca até `50` registros via `TypeOrmOutboxRepository.fetchDueMessages` (`published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()) ORDER BY occurred_at ASC FOR UPDATE SKIP LOCKED`), publica no SQS FIFO (`MessageGroupId = msg.aggregateId || 'default-group'`, `MessageDeduplicationId = msg.id`), marca `publishedAt` em sucesso ou agenda retry exponencial `min(60, 2^attempts)` segundos com `recordRetry('outbox')` em falha.
- **Reprocessamento periódico (`PendingReferencesJob`)**: Polling a cada `5000ms` executa `ReprocessPendingReferencesUseCase.execute(20)` para avaliar referências recém-chegadas ou expirar pendentes acima de 10 minutos (`REJECTED` / `REFERENCE_NOT_FOUND` + `WagerTransactionRejected` em `outbox_messages` via `UnitOfWork`).

### 4. Garantias no PostgreSQL e reversibilidade da migration
- **Decisão**: Nenhuma migration nova é criada; todas as garantias físicas permanecem na migration `1700000000000-initial-schema.ts` (`InitialSchema1700000000000`):
  - `wager_transactions`: `pk_wager_transactions`, `fk_wager_tx_wallet` e `fk_wager_tx_reference` (`ON DELETE RESTRICT`), `uq_wager_tx_provider_external`, `uq_wager_tx_idempotency_key`, `chk_wager_tx_kind`, `chk_wager_tx_status`, `chk_wager_tx_amount_positive (amount >= 0)`, além dos índices `idx_wager_tx_wallet_created`, `idx_wager_tx_round_player`, `idx_wager_tx_pending_reference` e do índice único parcial `uq_wager_tx_single_reversal (reference_transaction_id, kind) WHERE reference_transaction_id IS NOT NULL AND status = 'PROCESSED'`.
  - `inbox_messages`: `pk_inbox_messages (consumer_name, message_id)` e `idx_inbox_processed`.
  - `outbox_messages`: `pk_outbox_messages`, `chk_outbox_attempts (attempts >= 0)` e `idx_outbox_pending_polling (occurred_at ASC) WHERE published_at IS NULL`.
- **Reversibilidade**: O método `down` remove ordenadamente `outbox_messages`, `inbox_messages`, trigger/função de imutabilidade do ledger, `wallet_ledger_entries`, `wager_transactions` e `wallets`.

### 5. Fronteira explícita com a capacidade `wallets`
- **Decisão**: A capacidade `wallets` (`openspec/specs/wallets/spec.md`) é dona de `Wallet`, `WalletLedgerEntry`, endpoints `/wallets/**` e da transação interna `OPENING` criada na abertura com saldo positivo. A capacidade `wagering-transactions` proíbe `OPENING` nos contratos externos HTTP e SQS, coordena o ciclo de vida das operações `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`, e delega mutações de saldo e criação de lançamentos contábeis ao agregado `Wallet` e ao repositório de ledger dentro da mesma transação SQL.

## Risks / Trade-offs

1. **[Ressalva 1 — `ReprocessPendingReferencesUseCase` preso em replay idempotente]**
   Quando a referência chega como `PROCESSED`, `ReprocessPendingReferencesUseCase` chama `processWagerUseCase.execute` com a `idempotencyKey` original da transação `PENDING_REFERENCE`, caindo na checagem de idempotência que devolve `idempotentReplay: true` com `status = PENDING_REFERENCE` sem executar o handler de `REFUND`/`ROLLBACK` (nem expirar pelo TTL) → **Mitigação**: Retratar o comportamento vigente na baseline e implementar, em change futura dedicada, um caminho explícito de continuação para transações em `PENDING_REFERENCE` sob lock de carteira.

2. **[Ressalva 2 — Dupla reversão (`REFUND`/`ROLLBACK`) sem tratamento de domínio e furo entre tipos distintos]**
   Os handlers não verificam se a referência já foi revertida (`FailureCode.TransactionAlreadyReversed` nunca é emitido): duas reversões do mesmo `kind` colidem em `uq_wager_tx_single_reversal` (`23505`), não são encontradas no `catch` pelas chaves da nova transação e retornam `500 Internal Server Error` (com `recordLockConflict()` indevido). Além disso, o índice inclui `kind`, permitindo um `REFUND` e um `ROLLBACK` distintos sobre a mesma `BET` → **Mitigação**: Documentar como ressalva na baseline e corrigir em change futura com validação prévia no domínio + ajuste do índice único parcial apenas em `(reference_transaction_id)`.

3. **[Ressalva 3 — Exceções `500` em entradas omitidas/zero e falta de validação de titularidade na referência]**
   `SubmitWagerTransactionDto` marca `referenceExternalTransactionId` como `@IsOptional()` e `MoneyDto` aceita `"0.00"`, deixando `WagerTransaction.create` (`REFUND`/`ROLLBACK` sem referência) e `Wallet.debit`/`Wallet.credit` (`"0.00"` em `BET`/`WIN`/`REFUND`/`ROLLBACK`) lançarem `Error` genérico (`500`). Adicionalmente, `REFUND` e `ROLLBACK` não validam `refTx.playerId === tx.playerId` nem `refTx.walletId === tx.walletId` (`FailureCode.PlayerMismatch` nunca é emitido) → **Mitigação**: Registrar na baseline e tratar com validação condicional no DTO e regras explícitas nos handlers em change futura.

4. **[Ressalva 4 — Ordem carteira vs. idempotência e `FailureCode` não emitidos]**
   Validar existência (`404`), `playerId` (`422`) e `currency` (`422`) da carteira antes da busca por `idempotency_key` faz replays com chave existente e `playerId`/`currency`/`walletId` divergentes retornarem `422`/`404` em vez de `409 IDEMPOTENCY_PAYLOAD_MISMATCH`; além disso, tais rejeições não gravam `wager_transactions` (`REJECTED`), `outbox_messages` nem `failureCode` (`WALLET_NOT_FOUND`, `PLAYER_MISMATCH`, `CURRENCY_MISMATCH`) → **Mitigação**: Registrar o fluxo vigente na baseline e reavaliar a precedência idempotência-antes-de-elegibilidade em change futura.

5. **[Ressalva 5 — Colisão de contratos na mesma fila SQS FIFO (`SQS_WAGER_TRANSACTIONS_QUEUE_URL`)]**
   `OutboxPublisherJob` publica `IntegrationEvent` na mesma fila consumida por `SqsConsumerService`, cujo parser exige `SqsWagerMessageDto`, levando os eventos publicados à DLQ após `maxReceiveCount = 3` → **Mitigação**: Documentar na baseline e separar filas/tópicos de entrada (comandos) e saída (eventos) em change futura dedicada.

6. **[Ressalva 6 — `FOR UPDATE SKIP LOCKED` da Outbox executado fora de transação SQL]**
   `OUTBOX_REPOSITORY_PORT` usa `dataSource.manager` em autocommit, fazendo o lock de linha adquirido em `fetchDueMessages` expirar imediatamente após o `SELECT` antes do envio ao SQS e do `update` → **Mitigação**: Registrar na baseline e encapsular seleção, envio e marcação de publicação em transação controlada (ou mecanismo de lease/claim) em change futura.

7. **[Ressalva 7 — Validação permissiva no SQS, falta de teto na Outbox e retries de erros definitivos]**
   `SqsConsumerService` chama `validate(dto)` sem `whitelist`/`forbidNonWhitelisted` nem restrição de `type`, e não dá ACK em exceções `404`/`409`/`422` (gerando retries até a DLQ); `OutboxMessage` não possui limite máximo de `attempts` → **Mitigação**: Registrar na baseline para endurecimento futuro de DLQ/quarentena e validação estrita no consumer.

8. **[Ressalva 8 — Fallback sintético no Inbox e bypass em replay prévio]**
   Quando `ctx.inbox.exists` retorna `true` sem registro prévio em `wager_transactions`, retorna `transactionId: randomUUID()` sintético e `PROCESSED`; por outro lado, quando `wager_transactions` já existe (ex.: via HTTP), o replay retorna antes de gravar `inbox_messages` → **Mitigação**: Documentar o comportamento atual na baseline e unificar a persistência/retorno do `transactionId` real em change futura.

9. **[Ressalva 9 — Lacunas de cobertura de testes automatizados]**
   Não existem testes automatizados para `WageringController`, `GetWagerTransactionUseCase`, `ReprocessPendingReferencesUseCase`, `PendingReferencesJob`, `SqsConsumerService`, `OutboxPublisherJob`, `SqsWagerMessageDto`, constraints próprias de `wager_transactions`/`inbox_messages`/`outbox_messages` no PostgreSQL, dupla reversão, `ROLLBACK` de `REFUND` e `amount = "0.00"` em operações com impacto financeiro → **Mitigação**: Registrar o escopo atual na baseline e cobrir essas lacunas em change dedicada posterior de testes.
