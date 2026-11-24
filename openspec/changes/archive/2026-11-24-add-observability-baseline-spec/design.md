# Design

## Context

Este documento descreve a arquitetura vigente (*as-is*) da capacidade transversal `observability` cujos requisitos comportamentais estão definidos em `specs/observability/spec.md` e cuja motivação consta em `proposal.md` (`## Why`), sem introduzir alterações em código-fonte, testes, contratos HTTP/SQS ou migrations. A implementação atual opera sobre Bun (`bun test`), TypeScript em modo estrito ESM (imports relativos `.js`), NestJS, TypeORM, PostgreSQL e AWS SQS FIFO (LocalStack), distribuída entre `ObservabilityModule`, `HttpModule`, `ApplicationModule`, `MessagingModule` e `PersistenceModule`.

## Goals / Non-Goals

**Goals:**
- Documentar o isolamento do núcleo de domínio (`src/domain/`), a inversão de dependência via `MetricsCollectorPort`, a organização de `ObservabilityModule`, `MetricsService`, `MetricsController`, `HealthController`, `LoggingInterceptor`, `HttpExceptionFilter` e dos hooks de encerramento em `main.ts` e nos workers assíncronos.
- Explicitar os limites transacionais das consultas de métricas e sondas de prontidão em relação ao `UnitOfWork`, à ausência de locks sobre `walletId`, à propagação de `correlationId` para `InboxMessage`/`OutboxMessage` e ao uso de índices da migration `1700000000000-initial-schema.ts`.
- Formalizar as 7 ressalvas arquiteturais e operacionais identificadas para guiar futuras changes de refatoração (incluindo extração de Use Cases específicos, consistência multi-instância e cobertura de testes).

**Non-Goals:**
- Modificar arquivos em `src/**`, `tests/**` ou `openspec/config.yaml`.
- Criar novas migrations SQL ou alterar constraints, índices e triggers existentes.
- Reprojetar nesta change a coleta de métricas para armazenamento distribuído ou introduzir bibliotecas externas como `prom-client` ou OpenTelemetry.

## Decisions

### 1. Domínio 100% puro e metadados de correlação em `IntegrationEvent`
- **Decisão**: Preservar `src/domain/` completamente livre de `Logger`, `MetricsCollectorPort` ou qualquer import de NestJS, TypeORM e AWS SDK. O único ponto de contato com rastreabilidade no domínio é a classe abstrata `IntegrationEvent<T>` (`src/domain/messaging/integration-event.abstract.ts`), que transporta `eventId`, `aggregateId`, `correlationId`, `causationId?`, `occurredAt` e `version` de forma pura em objetos imutáveis (`Object.freeze`).
- **Alternativa considerada**: Emitir logs de auditoria ou incrementar contadores diretamente dentro de `Wallet` (`debit`/`credit`) e `WagerTransaction` (`reject`/`markProcessed`). Rejeitada por violar o isolamento do domínio puro e acoplar invariantes financeiras a efeitos colaterais de infraestrutura.

### 2. Inversão de dependência na coleta (`MetricsCollectorPort`) vs. acoplamento direto nas leituras
- **Decisão**: Para a gravação de telemetria a partir da camada `application` e dos workers de mensageria, o projeto define a porta `MetricsCollectorPort` (`METRICS_COLLECTOR_PORT` em `src/application/ports/metrics-collector.port.ts`) provida globalmente por `ObservabilityModule` (`@Global()` em `src/infrastructure/observability/observability.module.ts`) via `MetricsService`. `ProcessWagerTransactionUseCase`, `SqsConsumerService`, `OutboxPublisherJob` e `PendingReferencesJob` injetam a porta com `@Optional()`, permitindo testes unitários isolados sem container completo. Por outro lado, na implementação vigente, as consultas de leitura em `MetricsController` (`src/infrastructure/observability/metrics.controller.ts`) e `HealthController` (`src/infrastructure/http/controllers/health.controller.ts`) não passam por Use Cases dedicados na camada `application`, delegando diretamente a `MetricsService` ou a `DataSource`/`SQSClient` (ver Ressalva 3).
- **Alternativa considerada**: Acoplar `ProcessWagerTransactionUseCase` diretamente à classe concreta `MetricsService`. Rejeitada em favor de `MetricsCollectorPort` para preservar DIP no fluxo principal de apostas.

### 3. Pipeline HTTP transversal (`LoggingInterceptor` e `HttpExceptionFilter`) e propagação de `correlationId`
- **Decisão**: Registrar globalmente em `src/main.ts` `HttpExceptionFilter` (`useGlobalFilters`) e `LoggingInterceptor` (`useGlobalInterceptors`):
  - `LoggingInterceptor` (`src/infrastructure/http/interceptors/logging.interceptor.ts`) resolve `correlationId` na ordem `x-correlation-id -> idempotency-key -> randomUUID()`, sobrescreve `request.headers['x-correlation-id']`, define o header de saída `X-Correlation-Id` e registra `HTTP_REQUEST_COMPLETED` com `durationMs` via `tap()`.
  - `WageringController` (`src/infrastructure/http/controllers/wagering.controller.ts`) encaminha `correlationId` para `ProcessWagerTransactionUseCase`, que o injeta nos logs `TRANSACTION_*` e nos eventos `WalletBalanceChanged`, `WagerTransactionProcessed`, `WagerTransactionRejected` e `WagerTransactionPendingReference` persistidos na outbox. No canal SQS, `SqsConsumerService` deriva `correlationId` via `dto.messageId || txData.idempotencyKey || msg.MessageId`.
  - `HttpExceptionFilter` (`src/infrastructure/http/filters/http-exception.filter.ts`) captura qualquer exceção via `@Catch()` e uniformiza o JSON `{ statusCode, error, message, failureCode?, path, correlationId, timestamp }`.
- **Alternativa considerada**: Resolver `X-Correlation-Id` manualmente em cada controller. Rejeitada para evitar duplicação entre rotas de carteiras, apostas, health e métricas (embora a implementação como interceptor NestJS deixe pipes globais fora da cobertura; ver Ressalva 1).

### 4. Limites transacionais (`UnitOfWork`), ausência de lock por `walletId` e uso de índices SQL
- **Decisão**: Nenhuma operação de observabilidade abre `UnitOfWork` nem adquire lock pessimista (`SELECT ... FOR UPDATE`) sobre `wallets` (`walletId`):
  - Em `ProcessWagerTransactionUseCase`, o cálculo de `durationMs`, as chamadas a `MetricsCollectorPort` (`recordTransaction`, `recordDuplicateDetected`, `recordLockConflict`) e os logs estruturados ocorrem fora do callback transacional ou sem bloquear o commit atômico de `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages` e `outbox_messages`.
  - Em `ReconcileWalletUseCase`, o log `WALLET_RECONCILIATION_DIVERGENCE` é emitido somente após as leituras independentes de `WalletRepositoryPort` e `WalletLedgerRepositoryPort`, sem mutação de saldo.
  - Em `HealthController` (`SELECT 1` e `GetQueueAttributesCommand` na fila principal `envConfig.sqs.queueUrl`) e em `MetricsService` (`SELECT status, COUNT(*)::int FROM wager_transactions GROUP BY status`, agregação sobre `outbox_messages WHERE published_at IS NULL` e `GetQueueAttributesCommand` na DLQ `envConfig.sqs.dlqUrl`), todas as consultas executam em modo somente-leitura fora de transação explícita, aproveitando o índice parcial `idx_outbox_pending_polling (occurred_at ASC) WHERE published_at IS NULL` e a constraint `chk_wager_tx_status` da migration reversível `1700000000000-initial-schema.ts`.
- **Alternativa considerada**: Persistir cada amostra de latência e cada tentativa de replay em tabelas dedicadas no PostgreSQL dentro da transação financeira. Rejeitada na implementação original para não adicionar contenção de I/O no caminho crítico das apostas (gerando o trade-off de volatilidade multi-instância descrito na Ressalva 2).

### 5. Ciclo de vida operacional e Graceful Shutdown
- **Decisão**: Habilitar `app.enableShutdownHooks()` em `src/main.ts` (escutando `SIGTERM` e `SIGINT`) e implementar `OnModuleDestroy` em `SqsConsumerService` (`isShuttingDown = true`, `isRunning = false`), `OutboxPublisherJob` (`isShuttingDown = true`, `clearInterval`) e `PendingReferencesJob` (`clearInterval`), evitando que novos lotes sejam disparados enquanto conexões HTTP e pools de banco estão sendo encerrados.
- **Alternativa considerada**: Encerrar o processo imediatamente sem hooks de ciclo de vida. Rejeitada porque interromperia transações SQL em meio a commits antes do envio do `DeleteMessageCommand` (ACK) ao SQS.

### 6. Fronteiras com `wallets` e `wagering-transactions`
- **Decisão**: `wallets` permanece dona das regras contábeis e do contrato de `POST /wallets/:walletId/reconciliation`, enquanto `wagering-transactions` permanece dona da máquina de estados de apostas e dos fluxos Inbox/Outbox. A capacidade `observability` é dona exclusiva dos contratos `/health/**` e `/metrics/**`, do contrato transversal de `X-Correlation-Id`, do envelope global de erro HTTP, do catálogo de eventos de log JSON, da porta `MetricsCollectorPort` e da coordenação de graceful shutdown.

## Risks / Trade-offs

1. **[Ressalva 1 — Execução de pipes antes de `LoggingInterceptor` e omissão de log HTTP em exceções]**
   `ValidationPipe` global e `ParseUUIDPipe` executam antes dos interceptors no ciclo de vida do NestJS: requisições rejeitadas com `400 Bad Request` sem `X-Correlation-Id` enviado pelo cliente chegam a `HttpExceptionFilter` com `correlationId = "none"` e sem o header `X-Correlation-Id`; além disso, `tap()` não dispara em fluxos de erro, omitindo `HTTP_REQUEST_COMPLETED` em todas as respostas de exceção → **Mitigação**: Documentar fielmente na baseline e mover a resolução de `X-Correlation-Id` + log de acesso (sucesso e erro) para um middleware HTTP em change futura dedicada.

2. **[Ressalva 2 — Métricas híbridas (PostgreSQL global vs. memória volátil por instância)]**
   `MetricsService` lê `wager_transactions` (exceto `FAILED`, que nunca é persistido após rollback) e `outbox_messages` do PostgreSQL e atributos da DLQ do SQS, mas mantém `FAILED`, `duplicatesDetected`, `lockConflicts`, `retries` e `latenciesMs` (janela de `5000` amostras) apenas na memória local de cada processo → **Mitigação**: Registrar a limitação multi-instância na baseline e avaliar contadores distribuídos ou raspagem individual por pod/instância via labels no Prometheus em change futura.

3. **[Ressalva 3 — Ausência de Use Cases dedicados e acúmulo de responsabilidades em `HealthController` e `MetricsService`]**
   `HealthController` consulta `DataSource` e `SQSClient` diretamente na camada HTTP, e `MetricsService` concentra implementação de porta, queries SQL cruas, chamadas AWS SDK, cálculo estatístico e formatação texto Prometheus → **Mitigação**: Preservar o retrato *as-is* nesta baseline e extrair Use Cases específicos (`CheckReadinessUseCase`, `GetMetricsSnapshotUseCase`, etc.) e portas/adaptadores coesos em refatoração futura aderente a Clean Code e SOLID.

4. **[Ressalva 4 — Vazamento de `error.message` cru em respostas `500 Internal Server Error`]**
   Em exceções que não estendem `HttpException`, `HttpExceptionFilter` expõe `exception.message` diretamente no payload HTTP de erro → **Mitigação**: Documentar o comportamento atual na baseline e sanitizar respostas `500` com mensagem genérica pública mantendo detalhes apenas no log interno em change futura.

5. **[Ressalva 5 — Divergências de nomenclatura em `retries`, sufixo Prometheus `_avg` e semântica de contadores]**
   `GET /metrics` e `GET /metrics/messaging` expõem chaves diferentes para `retries`; `GET /metrics/prometheus` usa `wagering_processing_latency_ms_avg` sem `_sum` em métrica `summary`; `recordLockConflict()` captura violações `23505` de dupla reversão; `recordRetry('sqs')` ignora erros de validação DTO; e `recordRetry('pending_reference')` contabiliza também expirações por TTL → **Mitigação**: Registrar todos os contratos exatos na baseline e padronizar semântica/nomes de forma controlada em change futura.

6. **[Ressalva 6 — `onModuleDestroy` síncrono sem `await` de ciclo em voo e logs residuais em texto livre]**
   Os métodos `onModuleDestroy(): void` apenas sinalizam flags/limpam timers sem aguardar a conclusão da promessa de processamento corrente (`PendingReferencesJob` tampouco possui `isShuttingDown`), e logs fora do caminho feliz/transacional permanecem em texto não-JSON → **Mitigação**: Documentar na baseline e evoluir `onModuleDestroy` para aguardar promessas ativas junto com um logger JSON estruturado único em change futura.

7. **[Ressalva 7 — Lacunas de cobertura de testes automatizados em observabilidade]**
   A suíte atual cobre unitariamente `MetricsService` (em memória) e `MetricsController`, mas não testa `HealthController`, `LoggingInterceptor`, `HttpExceptionFilter`, consultas SQL/SQS reais de `MetricsService`, descarte acima de `5000` amostras nem invocações de `MetricsCollectorPort` nos casos de uso e workers → **Mitigação**: Registrar o estado atual em `tasks.md` e criar suíte dedicada de testes unitários e de integração em change posterior.
