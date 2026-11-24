# Proposal

## Why

A capacidade operacional de observabilidade (`observability`) já está implementada e em execução no projeto — abrangendo sondas públicas de liveness/readiness (`/health/**`), métricas operacionais e exportação Prometheus (`/metrics/**`), porta de telemetria (`MetricsCollectorPort`), correlação ponta a ponta (`X-Correlation-Id`), logs estruturados JSON, padronização global de erros HTTP (`HttpExceptionFilter`) e encerramento gracioso (`SIGTERM`/`SIGINT` e `OnModuleDestroy`) —, porém `openspec/specs/` contém apenas `wallets` e `wagering-transactions`, que deixaram explicitamente `/health/**`, `/metrics/**` e o comportamento transversal de diagnóstico fora de seu escopo. Formalizar a especificação baseline de `observability` fiel ao estado atual fecha 100% da superfície comportamental do serviço em uma fonte da verdade auditável e prepara a evolução segura por changes futuras.

## What Changes

- Criação da especificação baseline da capacidade `observability` em `specs/observability/spec.md`, retratando fielmente o comportamento atual dos 8 requisitos observáveis: sondas públicas de saúde (`/health/live` e `/health/ready`), correlação ponta a ponta (`X-Correlation-Id` e `correlationId` em eventos/SQS), envelope global de erros HTTP (`HttpExceptionFilter`), logs estruturados JSON nos fluxos críticos, coleta desacoplada via `MetricsCollectorPort` e janela deslizante de latência (`5000` amostras), endpoints JSON de métricas (`/metrics`, `/metrics/transactions`, `/metrics/messaging`, `/metrics/latency`) com degradação graciosa, exportação Prometheus (`/metrics/prometheus`) e encerramento gracioso de servidor e workers.
- Documentação arquitetural vigente (*as-is*) em `design.md`, mapeando `ObservabilityModule`, `MetricsCollectorPort`, `MetricsService`, `MetricsController`, `HealthController`, `LoggingInterceptor`, `HttpExceptionFilter`, hooks de ciclo de vida, consultas SQL sobre `wager_transactions` e `outbox_messages`, sondas SQS e fronteiras com `wallets` e `wagering-transactions`.
- Definição de checklist estritamente de revisão e validação da especificação em `tasks.md`, sem modificações em código de produção, testes ou migrations.
- Registro formal das 7 ressalvas técnicas identificadas na implementação atual (para tratamento em changes futuras dedicadas, sem alterar o comportamento vigente nesta change):
  1. Perda de `X-Correlation-Id` em falhas pré-interceptor e omissão de `HTTP_REQUEST_COMPLETED` em erros: `ValidationPipe` e `ParseUUIDPipe` executam antes de `LoggingInterceptor`, fazendo falhas `400 Bad Request` sem `X-Correlation-Id` enviado pelo cliente caírem em `HttpExceptionFilter` com `correlationId = "none"` e sem o header `X-Correlation-Id` na resposta; além disso, `LoggingInterceptor` registra `HTTP_REQUEST_COMPLETED` apenas no `tap()` de sucesso, omitindo o log de conclusão quando a rota lança exceção (`400`, `404`, `409`, `422`, `500`).
  2. Estado híbrido banco + memória local por instância em `MetricsService`: `transactions.byStatus` mescla contagens globais do PostgreSQL (`wager_transactions` agrupadas por `status`) com o contador `FAILED` em memória da instância (já que falhas sofrem rollback e não gravam `FAILED` no banco), enquanto `duplicatesDetected`, `lockConflicts`, `retries` e `latenciesMs` são voláteis e restritos ao processo local sem agregação entre múltiplas réplicas.
  3. Acoplamento direto de infraestrutura sem Use Cases dedicados em `/health/**` e `/metrics/**`: `HealthController` executa `DataSource.query` e `SQSClient.send` diretamente no controller HTTP, e `MetricsService` acumula coleta em memória, consultas SQL diretas, chamadas AWS SQS, cálculo de percentis e formatação Prometheus na mesma classe, divergindo da diretriz de Use Cases específicos e SRP.
  4. Exposição de `error.message` interno em erros `500 Internal Server Error`: quando captura um `Error` que não herda de `HttpException` (como falhas de domínio não mapeadas ou erros de driver SQL/TypeORM), `HttpExceptionFilter` devolve `error.message` cru no campo `message` da resposta HTTP.
  5. Divergências de contrato e semântica em métricas e formato Prometheus: o objeto `retries` usa chaves diferentes em `GET /metrics` (`sqsConsumerRetries`, `outboxRetries`, `pendingReferencesRetries`, `total`) e `GET /metrics/messaging` (`sqs`, `outbox`, `pendingReferences`); `GET /metrics/prometheus` declara `wagering_processing_latency_ms` como `summary` emitindo sufixo não-padrão `_avg` sem `_sum`; `recordLockConflict()` inclui violações `23505` de dupla reversão (`uq_wager_tx_single_reversal`); `recordRetry('sqs')` ignora mensagens barradas na validação de `SqsWagerMessageDto`; e `recordRetry('pending_reference')` soma tanto reprocessamentos quanto expirações por TTL.
  6. Encerramento gracioso sem espera explícita por promessas em voo e logs residuais em texto livre: `onModuleDestroy()` em `SqsConsumerService`, `OutboxPublisherJob` e `PendingReferencesJob` é síncrono (`void`), interrompendo novos agendamentos sem aguardar a conclusão do ciclo/mensagem já em execução (e `PendingReferencesJob` não possui flag `isShuttingDown`); adicionalmente, logs de bootstrap, erros 500 no filtro global, avisos de fallback em `MetricsService` e falhas de polling nos workers permanecem em texto livre fora do padrão JSON estruturado.
  7. Lacunas de cobertura de testes automatizados: ausência de testes para `HealthController` (`200` e `503`), `LoggingInterceptor`, `HttpExceptionFilter`, consultas reais de `MetricsService` contra PostgreSQL (`fetchTransactionsByStatus`, `fetchOutboxLag`) e SQS (`fetchDlqMetrics` nos estados `connected`, `not_configured` e `unavailable`), descarte FIFO acima de `5000` amostras e asserções sobre invocações de `MetricsCollectorPort` nos casos de uso e workers.

### Fora de escopo

- Alterações em código-fonte de domínio, aplicação ou infraestrutura (`src/**`).
- Criação, edição ou refatoração de testes automatizados (`tests/**`).
- Criação ou alteração de migrations, tabelas, índices, constraints ou triggers no PostgreSQL.
- Correção imediata das 7 ressalvas listadas acima (cada evolução deverá ocorrer em change futura própria após a baseline).
- Modificação das especificações já consolidadas `openspec/specs/wallets/spec.md` e `openspec/specs/wagering-transactions/spec.md`.
- Introdução de stack externa de telemetria distribuída (OpenTelemetry SDK, Jaeger/Tempo, agregadores externos de métricas) ou autenticação OIDC/OAuth2.

## Capabilities

### New Capabilities
- `observability`: Sondas públicas de liveness e readiness (`GET /health/live`, `GET /health/ready`), resolução e propagação ponta a ponta de `X-Correlation-Id` / `correlationId` em HTTP, SQS e `IntegrationEvent`, padronização global de respostas de erro HTTP (`HttpExceptionFilter`), emissão de logs estruturados JSON nos fluxos operacionais e de reconciliação contábil, coleta desacoplada de telemetria via `MetricsCollectorPort` com estatísticas de latência em janela deslizante (`5000` amostras), consulta de métricas operacionais em JSON (`GET /metrics`, `GET /metrics/transactions`, `GET /metrics/messaging`, `GET /metrics/latency`) com degradação graciosa, exportação compatível com raspagem Prometheus (`GET /metrics/prometheus`) e encerramento gracioso (`SIGTERM`/`SIGINT` e `OnModuleDestroy`).

### Modified Capabilities
<!-- Nenhuma capacidade existente tem requisitos alterados; trata-se da criação da especificação baseline de observability. -->

## Impact

- **Migrations de banco de dados**: nenhum impacto; não há criação nem alteração de migrations ou objetos SQL (as leituras de `MetricsService` seguem apoiadas nas tabelas `wager_transactions` e `outbox_messages` e no índice `idx_outbox_pending_polling` definidos em `1700000000000-initial-schema.ts`).
- **Compatibilidade de API HTTP e mensagens SQS**: sem quebras ou alterações (`0` breaking changes); todas as rotas `/health/**` e `/metrics/**`, o header `X-Correlation-Id`, o envelope de erro HTTP e os contratos de eventos/filas SQS permanecem idênticos ao comportamento atual.
- **Novas dependências**: nenhuma dependência adicionada ao `package.json`.
- **Artefatos afetados**: exclusivamente os artefatos de planejamento em `openspec/changes/add-observability-baseline-spec/` (e futuramente `openspec/specs/observability/spec.md` quando sincronizado/arquivado).
