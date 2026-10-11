# Guia de Avaliação Técnica — Distributed Wagering Processor

Este documento foi elaborado para facilitar a avaliação técnica do projeto, mapeando detalhadamente cada critério da seção **"14. Avaliação — 100 pontos"** do [project-scope.md](project-scope.md) para os respectivos arquivos de implementação, schemas de banco de dados e suítes de testes automatizados.

---

## 📊 Matriz de Avaliação (100 Pontos)

| # | Área | Pontos | O que é observado | Status |
|---|---|:---:|---|:---:|
| 1 | **Correção Financeira** | 20 | `Money`, saldo, ledger, reversões, reconciliação | ✅ 100% Atendido |
| 2 | **Concorrência** | 20 | Lost updates, hot wallet, múltiplas instâncias, locks | ✅ 100% Atendido |
| 3 | **Idempotência** | 15 | Deduplicação persistente, replay idêntico, payload conflitante | ✅ 100% Atendido |
| 4 | **Mensageria e Falhas** | 15 | Transactional Inbox, Outbox, retry, DLQ, crash recovery, shutdown | ✅ 100% Atendido |
| 5 | **Modelagem e Arquitetura** | 10 | Invariantes em classes puras, boundaries, portas, simplicidade | ✅ 100% Atendido |
| 6 | **Testes Automatizados** | 10 | Integração real, races reais, determinismo, cobertura | ✅ 100% Atendido |
| 7 | **Observabilidade** | 5 | Logs estruturados, métricas, health checks, diagnóstico | ✅ 100% Atendido |
| 8 | **Documentação** | 5 | `README.md` completo, `ARCHITECTURE.md`, trade-offs e decisões | ✅ 100% Atendido |

---

## 🔍 Mapeamento Detalhado por Área

### 1. Correção Financeira (20 Pontos)

* **Proibição estrita de ponto flutuante (`number`)**:
  - Implementação através do Value Object `Money`, baseado em `decimal.js`, com escala de 2 casas decimais e validação de formato monetário.
  - **Arquivo**: [`src/domain/shared/money.value-object.ts`](../src/domain/shared/money.value-object.ts)
  - **Testes**: [`tests/unit/money.value-object.spec.ts`](../tests/unit/money.value-object.spec.ts)

* **Saldo e Invariante Não Negativa**:
  - Validado no agregado `Wallet` (`debit` valida saldo suficiente) e garantido no PostgreSQL por `CHECK constraint`.
  - **Arquivo**: [`src/domain/wallet/wallet.aggregate.ts`](../src/domain/wallet/wallet.aggregate.ts)
  - **Schema/Constraint**: [`src/infrastructure/persistence/migrations/1700000000000-initial-schema.ts`](../src/infrastructure/persistence/migrations/1700000000000-initial-schema.ts) (`CONSTRAINT chk_wallets_balance_non_negative CHECK (balance_amount >= 0)`)
  - **Testes**: [`tests/unit/wallet.aggregate.spec.ts`](../tests/unit/wallet.aggregate.spec.ts) e [`tests/integration/database-constraints.spec.ts`](../tests/integration/database-constraints.spec.ts)

* **Ledger Imutável e Balanceamento Contábil**:
  - Cada movimentação financeira que altera saldo gera exatamente 1 lançamento em `wallet_ledger_entries`.
  - Validação da equação aritmética contábil (`balanceBefore ± amount = balanceAfter`) em domínio e via constraint SQL `chk_ledger_balanced`.
  - Trigger nativo no PostgreSQL (`trg_prevent_ledger_mutation`) impedindo fisicamente qualquer `UPDATE` ou `DELETE`.
  - **Entidade**: [`src/domain/wallet/wallet-ledger.entity.ts`](../src/domain/wallet/wallet-ledger.entity.ts)
  - **Trigger SQL**: [`src/infrastructure/persistence/migrations/1700000000000-initial-schema.ts`](../src/infrastructure/persistence/migrations/1700000000000-initial-schema.ts)
  - **Testes**: [`tests/unit/wallet-ledger.entity.spec.ts`](../tests/unit/wallet-ledger.entity.spec.ts) e [`tests/integration/database-constraints.spec.ts`](../tests/integration/database-constraints.spec.ts)

* **Reversões Contábeis (`REFUND` e `ROLLBACK`)**:
  - Suporte completo aos tipos `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
  - Validação da referência original (valor idêntico, mesma rodada, estado processado). O rollback inverte a direção do ledger (WIN/REFUND vira DEBIT, BET vira CREDIT) com proteção contra saldo negativo (`INSUFFICIENT_FUNDS_FOR_REVERSAL`).
  - Reversão única garantida por índice único parcial `uq_wager_tx_single_reversal`.
  - **Caso de Uso**: [`src/application/use-cases/process-wager-transaction.use-case.ts`](../src/application/use-cases/process-wager-transaction.use-case.ts)
  - **Domínio**: [`src/domain/wagering/wager-transaction.aggregate.ts`](../src/domain/wagering/wager-transaction.aggregate.ts)
  - **Testes**: [`tests/unit/reversals-and-references.spec.ts`](../tests/unit/reversals-and-references.spec.ts)

* **Reconciliação Contábil**:
  - Recalcula o saldo auditável somando os lançamentos contábeis (`SUM(CREDIT) - SUM(DEBIT)`) e compara com `storedBalance`. Divergências são acusadas na resposta e registradas em log estruturado.
  - **Caso de Uso**: [`src/application/use-cases/reconcile-wallet.use-case.ts`](../src/application/use-cases/reconcile-wallet.use-case.ts)
  - **Endpoint REST**: `POST /wallets/:walletId/reconciliation` em [`src/infrastructure/http/controllers/wallet.controller.ts`](../src/infrastructure/http/controllers/wallet.controller.ts)
  - **Testes**: [`tests/unit/reconcile-wallet.use-case.spec.ts`](../tests/unit/reconcile-wallet.use-case.spec.ts)

---

### 2. Concorrência e Ordenação (20 Pontos)

* **Unidade de Concorrência & Lock Pessimista**:
  - `walletId` como unidade de concorrência. Lock pessimista `SELECT ... FOR UPDATE` (`pessimistic_write`) adquirido no início da transação do banco, serializando operações na mesma carteira e isolando carteiras independentes.
  - **Arquivo**: [`src/application/use-cases/process-wager-transaction.use-case.ts`](../src/application/use-cases/process-wager-transaction.use-case.ts) (linha 208)
  - **Repositório**: [`src/infrastructure/persistence/repositories/typeorm-wallet.repository.ts`](../src/infrastructure/persistence/repositories/typeorm-wallet.repository.ts)

* **Resiliência em Múltiplas Instâncias e Race Conditions**:
  - Corrida por chave idêntica entre instâncias simultâneas é tratada capturando erro de Unique Violation (`23505`) no PostgreSQL, re-executando a leitura da transação recém-comitada e devolvendo replay idêntico determinístico.
  - **Arquivo**: [`src/application/use-cases/process-wager-transaction.use-case.ts`](../src/application/use-cases/process-wager-transaction.use-case.ts) (linhas 632-675)

* **Locks em Background sem Disputa (`SKIP LOCKED`)**:
  - O worker de Outbox consome lotes com `FOR UPDATE SKIP LOCKED`, permitindo escalar réplicas em paralelo sem disputa.
  - **Arquivo**: [`src/infrastructure/persistence/repositories/typeorm-outbox.repository.ts`](../src/infrastructure/persistence/repositories/typeorm-outbox.repository.ts) (linha 51)

* **Testes de Concorrência Real**:
  - Cenário obrigatório: duas apostas de `80.00 BRL` disputando saldo de `100.00 BRL` simultaneamente no PostgreSQL (1 `PROCESSED`, 1 `REJECTED`, saldo final `20.00 BRL`, 1 único lançamento no ledger).
  - Cenário de 50 requisições simultâneas para a mesma aposta (1 nova execução, 49 replays idênticos).
  - **Arquivo**: [`tests/concurrency/wallet-concurrency.spec.ts`](../tests/concurrency/wallet-concurrency.spec.ts)

---

### 3. Idempotência (15 Pontos)

* **Deduplicação Persistente**:
  - Fonte da verdade persistida em `wager_transactions` através de constraints únicas em `idempotency_key` e `(provider_id, external_transaction_id)`.
  - **Migration**: [`src/infrastructure/persistence/migrations/1700000000000-initial-schema.ts`](../src/infrastructure/persistence/migrations/1700000000000-initial-schema.ts)

* **Hash Canônico de Negócio**:
  - Algoritmo de hash SHA-256 gerado a partir de chaves recursivamente ordenadas de subconjunto de campos de negócio (header e transporte desconsiderados).
  - **Utilitário**: [`src/domain/shared/canonical-json.util.ts`](../src/domain/shared/canonical-json.util.ts)
  - **Testes**: [`tests/unit/canonical-json.spec.ts`](../tests/unit/canonical-json.spec.ts)

* **Replay Idêntico vs Payload Conflitante**:
  - Requisição com mesma chave e mesmo hash canônico retorna resposta original com `idempotentReplay: true`.
  - Mesma chave com payload de negócio divergente rejeita com `HTTP 409 Conflict` e failure code `IDEMPOTENCY_PAYLOAD_MISMATCH`.
  - **Implementação**: [`src/application/use-cases/process-wager-transaction.use-case.ts`](../src/application/use-cases/process-wager-transaction.use-case.ts) (linhas 233-251)
  - **Testes**: [`tests/unit/process-wager-transaction.use-case.spec.ts`](../tests/unit/process-wager-transaction.use-case.spec.ts)

---

### 4. Mensageria e Tratamento de Falhas (15 Pontos)

* **Transactional Inbox**:
  - Mensagens SQS registram tupla `(consumer_name, message_id)` na tabela `inbox_messages` na mesma transação atômica da alteração de saldo.
  - ACK (`DeleteMessageCommand`) enviado **exclusivamente após o commit**. Redelivery é descartado pelo inbox.
  - **Migration**: [`src/infrastructure/persistence/migrations/1700000000000-initial-schema.ts`](../src/infrastructure/persistence/migrations/1700000000000-initial-schema.ts) (linha 113)
  - **Consumidor SQS**: [`src/infrastructure/messaging/sqs/sqs-consumer.service.ts`](../src/infrastructure/messaging/sqs/sqs-consumer.service.ts)

* **Transactional Outbox**:
  - Eventos de integração herdam da classe abstrata `IntegrationEvent<T>` com tipos e versões declaradas no próprio tipo.
  - Persistidos em `outbox_messages` na mesma transação atômica.
  - Worker agendado publica no SQS FIFO com deduplicação nativa por `messageId` e ordenação por `aggregateId` (`MessageGroupId`).
  - **Eventos**: [`src/domain/messaging/integration-event.abstract.ts`](../src/domain/messaging/integration-event.abstract.ts)
  - **Worker Outbox**: [`src/infrastructure/messaging/jobs/outbox-publisher.job.ts`](../src/infrastructure/messaging/jobs/outbox-publisher.job.ts)

* **Retry, DLQ e Referências Fora de Ordem**:
  - Mensagens com falhas transitórias não recebem ACK e caem na DLQ FIFO após estouro de tentativas.
  - Operações `REFUND`/`ROLLBACK` órfãs de referência são gravadas como `PENDING_REFERENCE` e reprocessadas periodicamente pelo job de referências, com rejeição definitiva (`REFERENCE_NOT_FOUND`) após TTL de 10 minutos.
  - **Worker Referências**: [`src/infrastructure/messaging/jobs/pending-references.job.ts`](../src/infrastructure/messaging/jobs/pending-references.job.ts)
  - **Caso de Uso**: [`src/application/use-cases/reprocess-pending-references.use-case.ts`](../src/application/use-cases/reprocess-pending-references.use-case.ts)

* **Graceful Shutdown**:
  - Serviços implementam `OnModuleDestroy`, interrompendo polling e permitindo concluir transações em voo antes de finalizar.
  - **Arquivos**: [`src/infrastructure/messaging/sqs/sqs-consumer.service.ts`](../src/infrastructure/messaging/sqs/sqs-consumer.service.ts) e [`src/infrastructure/messaging/jobs/outbox-publisher.job.ts`](../src/infrastructure/messaging/jobs/outbox-publisher.job.ts)

---

### 5. Modelagem e Arquitetura (10 Pontos)

* **Domínio Puro e Invariantes Encapsuladas**:
  - Zero dependência de frameworks ou ORM no diretório `src/domain`. Mutações de saldo, versionamento e regras contábeis isoladas.
  - **Diretório**: [`src/domain/`](../src/domain/)

* **Hexagonal / Clean Architecture (Ports & Adapters)**:
  - Camada de aplicação orientada a interfaces/portas (`UnitOfWorkPort`, `WalletRepositoryPort`, etc.).
  - Padrão **Data Mapper**: entidades de domínio estritamente separadas das entidades ORM TypeORM.
  - **Portas**: [`src/application/ports/`](../src/application/ports/)
  - **Adaptadores**: [`src/infrastructure/persistence/repositories/`](../src/infrastructure/persistence/repositories/)

* **Reutilização e Simplicidade**:
  - O mesmo caso de uso (`ProcessWagerTransactionUseCase`) atende tanto a entrada HTTP REST quanto as mensagens recebidas via fila AWS SQS FIFO.
  - **Arquivo**: [`src/application/use-cases/process-wager-transaction.use-case.ts`](../src/application/use-cases/process-wager-transaction.use-case.ts)

---

### 6. Testes Automatizados (10 Pontos)

* **Integração Real contra PostgreSQL**:
  - Validação física de constraints `CHECK`, `UNIQUE` e triggers de imutabilidade sem mocks.
  - **Arquivo**: [`tests/integration/database-constraints.spec.ts`](../tests/integration/database-constraints.spec.ts)

* **Concorrência e Paralelismo Real**:
  - Testes concorrentes executados com conexões reais via `Promise.all` contra o PostgreSQL (lost updates, 50 requisições simultâneas).
  - **Arquivo**: [`tests/concurrency/wallet-concurrency.spec.ts`](../tests/concurrency/wallet-concurrency.spec.ts)

* **Cobertura Completa de Casos de Borda e Domínio**:
  - 70 testes automatizados cobrindo `Money`, `Wallet`, `Ledger`, `WagerTransaction`, reversões, ordenação fora de ordem, DTOs e observabilidade.
  - **Diretório**: [`tests/unit/`](../tests/unit/)

---

### 7. Observabilidade (5 Pontos)

* **Logs Estruturados (JSON)**:
  - Formato JSON contendo `event`, `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `kind`, `durationMs`. Payloads e dados confidenciais são omitidos.
  - **Arquivo**: [`src/application/use-cases/process-wager-transaction.use-case.ts`](../src/application/use-cases/process-wager-transaction.use-case.ts) (linhas 78-190)

* **Métricas em Tempo Real & Prometheus**:
  - Métricas cobrindo transações por status, duplicatas detectadas, conflitos de concorrência, retries, DLQ, outbox lag e percentis de latência (`p50`, `p95`, `p99`, `avg`).
  - Disponível em JSON consolidado e no formato de texto Prometheus (`/metrics/prometheus`).
  - **Serviço**: [`src/infrastructure/observability/metrics.service.ts`](../src/infrastructure/observability/metrics.service.ts)
  - **Controller**: [`src/infrastructure/observability/metrics.controller.ts`](../src/infrastructure/observability/metrics.controller.ts)
  - **Testes**: [`tests/unit/metrics.service.spec.ts`](../tests/unit/metrics.service.spec.ts) e [`tests/unit/metrics.controller.spec.ts`](../tests/unit/metrics.controller.spec.ts)

* **Health Checks**:
  - Endpoints sem autenticação para `/health/live` (processo ativo) e `/health/ready` (testes de conectividade ativa com PostgreSQL e LocalStack SQS FIFO).
  - **Controller**: [`src/infrastructure/http/controllers/health.controller.ts`](../src/infrastructure/http/controllers/health.controller.ts)

---

### 8. Documentação (5 Pontos)

* **README Operacional Completo**:
  - Passo a passo de setup, Docker, variáveis de ambiente, comandos de teste e documentação de todos os endpoints REST com payloads e respostas.
  - **Arquivo**: [`README.md`](../README.md)

* **ARCHITECTURE com Decisões Técnicas e Trade-offs**:
  - Racional de concorrência, precisão decimal, imutabilidade do ledger, Transactional Inbox/Outbox e limites do sistema.
  - **Arquivo**: [`ARCHITECTURE.md`](../ARCHITECTURE.md)

* **Documentações Específicas de Apoio**:
  - Modelagem do banco, constraints e DDL: [`docs/database-modeling.md`](database-modeling.md)
  - Diagramas de sequência e fluxogramas de decisão (Mermaid): [`docs/wagering-transactions-flow.md`](wagering-transactions-flow.md)

---

## 🚫 Checklist de Falhas Eliminatórias

| Falha Eliminatória | Status no Projeto | Mecanismo de Prevenção |
|---|:---:|---|
| **`number` para dinheiro** | ✅ **Livre** | Value Object `Money` baseado em `decimal.js` com escala fixa (`toFixed(2)`). |
| **Saldo negativo por race** | ✅ **Livre** | Lock pessimista `SELECT ... FOR UPDATE` + constraint `chk_wallets_balance_non_negative`. |
| **Débito ou crédito duplicado** | ✅ **Livre** | Deduplicação por hash canônico no banco e Transactional Inbox por `(consumer, messageId)`. |
| **Idempotência apenas em memória** | ✅ **Livre** | 100% persistida no PostgreSQL com constraints `UNIQUE`. |
| **Solução correta só com 1 instância** | ✅ **Livre** | Locks e atomicidade delegados ao PostgreSQL; Outbox usa `SKIP LOCKED`. |
| **Publicação de evento antes do commit** | ✅ **Livre** | Transactional Outbox (o evento só é gravado e publicado pós-commit). |
| **Ausência de ledger auditável** | ✅ **Livre** | Tabela `wallet_ledger_entries` estruturalmente append-only com trigger de imutabilidade. |
| **Testes com mocks substituindo banco/SQS** | ✅ **Livre** | Testes de integração e concorrência rodam contra PostgreSQL e LocalStack reais. |

---

## ⚡ Comandos Rápidos para Validação

```bash
# Executar todos os testes automatizados (70 testes passando)
bun test

# Testes de integração (constraints e triggers reais no PostgreSQL)
bun run test:integration

# Testes de concorrência real (duas apostas de 80 disputando 100 e 50 requisições simultâneas)
bun run test:concurrency

# Testes unitários de domínio puro e casos de uso
bun run test:unit
```
