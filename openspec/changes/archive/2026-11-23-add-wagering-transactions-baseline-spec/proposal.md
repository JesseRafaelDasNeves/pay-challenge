# Proposal

## Why

A capacidade de processamento de transações de apostas (`wagering-transactions`) já está implementada e operando no projeto — cobrindo endpoints HTTP, casos de uso por tipo de transação, idempotência persistente, tratamento de referências fora de ordem, Transactional Inbox via SQS FIFO e Transactional Outbox —, porém `openspec/specs/` contém atualmente apenas a baseline `wallets` (`openspec/specs/wallets/spec.md`), que delimitou explicitamente `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` fora de seu escopo. Formalizar a especificação baseline de `wagering-transactions` com base fiel no comportamento atual estabelece uma fonte de verdade durável para rastreabilidade, auditoria arquitetural e evolução controlada por futuras changes.

## What Changes

- Criação da especificação baseline da capacidade `wagering-transactions` em `specs/wagering-transactions/spec.md`, retratando estritamente os contratos HTTP e SQS FIFO, regras de domínio, máquina de estados, idempotência persistente, serialização por `walletId`, reversões e referências pendentes, constraints do PostgreSQL, Transactional Inbox e Transactional Outbox atualmente implementados (11 requisitos observáveis).
- Documentação arquitetural vigente (*as-is*) em `design.md`, mapeando domínio puro, casos de uso dedicados, portas, adaptadores de persistência/HTTP/mensageria, limites transacionais, estratégia de lock e fronteira com a capacidade `wallets`.
- Definição de checklist estritamente de revisão e validação da especificação em `tasks.md`, sem alterações em código de produção, testes ou migrations.
- Registro formal das 9 ressalvas técnicas observadas na implementação atual (para endereçamento em changes futuras dedicadas, sem modificar o comportamento vigente nesta change):
  1. `ReprocessPendingReferencesUseCase` cai em replay idempotente ao invocar `ProcessWagerTransactionUseCase` com a mesma `idempotencyKey`, mantendo a transação presa em `PENDING_REFERENCE` mesmo após a referência atingir `PROCESSED` (e impedindo expiração pelo TTL de 10 minutos enquanto `ref.status === PROCESSED`).
  2. Dupla reversão (`REFUND`/`ROLLBACK`) sem verificação prévia no domínio (`FailureCode.TransactionAlreadyReversed` nunca é emitido): dois estornos do mesmo `kind` falham no índice único parcial `uq_wager_tx_single_reversal` (`23505`) e vazam como `500 Internal Server Error` (incrementando indevidamente `lockConflicts`); além disso, o índice inclui `kind`, não impedindo `REFUND` + `ROLLBACK` combinados sobre a mesma `BET`.
  3. Validações que vazam como `500 Internal Server Error` e checagens omitidas em reversões: `referenceExternalTransactionId` omitido em `REFUND`/`ROLLBACK` (aceito por `SubmitWagerTransactionDto` via `@IsOptional`, falha em `WagerTransaction.create`), `money.amount = "0.00"` em `BET`/`WIN`/`REFUND`/`ROLLBACK` (aceito por `MoneyDto` e `WagerTransaction.create`, falha em `Wallet.debit`/`Wallet.credit`) e ausência de validação de `refTx.playerId`/`refTx.walletId` (`FailureCode.PlayerMismatch` nunca é emitido).
  4. Ordem de validação carteira vs. idempotência e `FailureCode` não emitidos: validações de carteira (`404` carteira inexistente, `422` `playerId` divergente, `422` moeda divergente) ocorrem antes da checagem de idempotência e lançam exceções sem persistir registro `REJECTED`, sem enfileirar evento na outbox e sem `failureCode` (`WALLET_NOT_FOUND`, `PLAYER_MISMATCH`, `CURRENCY_MISMATCH`), fazendo replays com chave existente e `playerId`/`currency`/`walletId` alterados retornarem `422`/`404` em vez de `409 IDEMPOTENCY_PAYLOAD_MISMATCH`.
  5. Colisão de contratos na mesma fila SQS FIFO (`SQS_WAGER_TRANSACTIONS_QUEUE_URL`): `OutboxPublisherJob` publica `IntegrationEvent` na mesma fila consumida por `SqsConsumerService` (que exige `SqsWagerMessageDto`), fazendo eventos da outbox falharem na validação (`SQS_MESSAGE_PAYLOAD_INVALID`) e irem à DLQ após `maxReceiveCount = 3`.
  6. `FOR UPDATE SKIP LOCKED` da outbox executado em autocommit: `OutboxPublisherJob` chama `outboxRepository.fetchDueMessages(50)` sobre `dataSource.manager` fora de uma transação SQL explícita, liberando o lock de linha antes de publicar no SQS e atualizar `published_at`.
  7. Validação frouxa no consumidor SQS (`validate(dto)` sem `whitelist`/`forbidNonWhitelisted` e sem restrição de valores em `type`), ausência de teto de `attempts` na tabela `outbox_messages`, e tratamento uniforme de exceções definitivas (`404`/`409`/`422`) no `SqsConsumerService` como retentativas transitórias até a DLQ.
  8. Fallback sintético no Transactional Inbox (`transactionId: randomUUID()` e `status: PROCESSED` quando `ctx.inbox.exists` retorna `true` sem registro prévio em `wager_transactions`) e ausência de registro em `inbox_messages` quando o replay idempotente retorna antes do passo de Inbox.
  9. Lacunas de cobertura automatizada: ausência de testes para `WageringController`, `GetWagerTransactionUseCase`, `ReprocessPendingReferencesUseCase`, `PendingReferencesJob`, `SqsConsumerService`, `OutboxPublisherJob`, `SqsWagerMessageDto`, constraints próprias de `wager_transactions`/`inbox_messages`/`outbox_messages` no PostgreSQL, dupla reversão, `ROLLBACK` de `REFUND` e `amount = "0.00"` fora de `LOSS`.

### Fora de escopo

- Alterações em código-fonte de aplicação, domínio ou infraestrutura (`src/**`).
- Criação, edição ou refatoração de testes automatizados (`tests/**`).
- Criação ou alteração de migrations e schema SQL.
- Correção imediata das 9 ressalvas mapeadas acima (cada correção deverá ser proposta e implementada em change futura dedicada após a baseline).
- Modificação da especificação consolidada `openspec/specs/wallets/spec.md` (preservando a fronteira já documentada da transação interna `OPENING` na abertura de carteira com saldo positivo).
- Especificação detalhada dos endpoints operacionais `/health/**` e `/metrics/**` (citando apenas a emissão de métricas pelo `MetricsCollectorPort` quando aplicável ao processamento de transações e retentativas).
- Implementação de autenticação/autorização via Identity Provider externo (OIDC/OAuth2).

## Capabilities

### New Capabilities
- `wagering-transactions`: Submissão HTTP e validação contratual de transações de apostas (`POST /wagering/transactions`), consulta por identificador interno e por provedor (`GET /wagering/transactions/:transactionId`, `GET /providers/:providerId/wagering/transactions/:externalTransactionId`), elegibilidade da carteira e serialização por `walletId`, idempotência persistente por `idempotency_key` e `(provider_id, external_transaction_id)` com hash canônico SHA-256, processamento de `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`, tratamento de referências fora de ordem (`PENDING_REFERENCE`) com TTL de 10 minutos, integridade no PostgreSQL, consumo assíncrono via SQS FIFO com Transactional Inbox (`SqsConsumerService`) e publicação assíncrona via Transactional Outbox (`OutboxPublisherJob`).

### Modified Capabilities
<!-- Nenhuma capacidade existente modificada; trata-se da criação da especificação baseline de wagering-transactions. -->

## Impact

- **Migrations de banco de dados**: nenhum impacto; não há criação ou alteração de migrations nem de schema SQL (mantém integralmente a migration `1700000000000-initial-schema.ts` e as tabelas `wager_transactions`, `wallets`, `wallet_ledger_entries`, `inbox_messages` e `outbox_messages`).
- **Compatibilidade de API HTTP e mensagens SQS**: sem alterações ou quebras (`0` breaking changes); os endpoints `POST /wagering/transactions`, `GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId`, o envelope `SqsWagerMessageDto` e os eventos de integração v1 permanecem 100% compatíveis com o estado atual.
- **Novas dependências**: nenhuma dependência adicionada ao `package.json`.
- **Artefatos afetados**: apenas arquivos de planejamento em `openspec/changes/add-wagering-transactions-baseline-spec/` (e posteriormente `openspec/specs/wagering-transactions/spec.md` após sincronização/arquivamento).
