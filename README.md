# Distributed Wagering Processor

Serviço financeiro distribuído de alta consistência para processamento de apostas de múltiplos provedores de jogos, implementado com **Bun**, **TypeScript**, **NestJS**, **TypeORM**, **PostgreSQL** e **AWS SQS FIFO (LocalStack)**.

---

## 🚀 Tecnologias e Arquitetura

- **Runtime & Test Runner**: [Bun 1.4.2](https://bun.sh)
- **Framework**: [NestJS 12.1.2](https://nestjs.com)
- **ORM & Banco de Dados**: [TypeORM](https://typeorm.io) com [PostgreSQL 18.1](https://www.postgresql.org)
- **Mensageria**: AWS SQS FIFO emulado via [LocalStack 3.8.1](https://localstack.cloud)
- **Arquitetura**: Clean Architecture (Ports & Adapters) + DDD (Domain-Driven Design)
- **Padrões de Resiliência**: Transactional Inbox, Transactional Outbox com `FOR UPDATE SKIP LOCKED`, Lock Pessimista por Carteira (`SELECT ... FOR UPDATE`), Idempotência Persistente baseada em Hash Canônico SHA-256.

Consulte a documentação técnica detalhada do projeto:
- 📋 **Guia de Avaliação Técnica (Critérios da Seção 14 / 100 pontos)**: [docs/evaluation-guide.md](docs/evaluation-guide.md)
- 🏛️ **Decisões Técnicas & Arquitetura**: [ARCHITECTURE.md](ARCHITECTURE.md)
- 🗄️ **Modelagem do Banco de Dados & Invariantes**: [docs/database-modeling.md](docs/database-modeling.md)
- 🔄 **Fluxo do Endpoint de Transações**: [docs/wagering-transactions-flow.md](docs/wagering-transactions-flow.md)

---

## 🛠️ Pré-requisitos e Configuração

### Variáveis de Ambiente (`.env`)

```env
POSTGRES_PAY_CHALLENGE_DB="xxx"
POSTGRES_PAY_CHALLENGE_USER="xxx"
POSTGRES_PAY_CHALLENGE_PASSWORD="xxx"

# AWS SQS
AWS_REGION="xxx"
AWS_ENDPOINT="xxx"
AWS_ACCESS_KEY_ID="xxx"
AWS_SECRET_ACCESS_KEY="xxx"

# URLs das Filas SQS
SQS_WAGER_TRANSACTIONS_QUEUE_URL="xxx"
SQS_WAGER_TRANSACTIONS_DLQ_URL="xxx"
```

---

## 📦 Inicialização do Ambiente

### 1. Subir Containers Docker (PostgreSQL + LocalStack)
```bash
docker compose up -d
```

### 2. Instalar Dependências
```bash
bun install
```

### 3. Executar Migrations do Banco de Dados
Aplica o schema completo, constraints `CHECK`, índices únicos parciais e o trigger de imutabilidade do ledger (especificação detalhada em [docs/database-modeling.md](docs/database-modeling.md)):
```bash
bun run migration:run
```

### 4. Iniciar a Aplicação
```bash
# Modo desenvolvimento com hot-reload:
bun run start:dev

# Ou modo direto:
bun run start
```
A API estará disponível em: `http://localhost:3000`

---

## 🧪 Testes Automatizados

O projeto conta com uma suíte de testes cobrindo testes unitários de domínio puro, validação estrita de DTOs, integração com constraints reais do PostgreSQL e concorrência real:

```bash
# Executar todos os testes:
bun test

# Testes unitários (Money, Wallet, Ledger, WagerTransaction, Casos de Uso, DTOs):
bun run test:unit

# Testes de integração (PostgreSQL constraints, triggers de imutabilidade, checks):
bun run test:integration

# Testes de concorrência real (Disputa de saldo simultânea e 50 requisições paralelas):
bun run test:concurrency
```

---

## 🌐 Endpoints da API REST

### 1. Carteiras (`/wallets`)

#### Criar Carteira
- **`POST /wallets`**
- **Payload:**
  ```json
  {
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }
  ```
- **Resposta (201 Created):**
  ```json
  {
    "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "balance": { "amount": "1000.00", "currency": "BRL" },
    "version": 1
  }
  ```

#### Consultar Carteira
- **`GET /wallets/:walletId`**

#### Extrato com Paginação por Cursor
- **`GET /wallets/:walletId/ledger?limit=50&cursor=...`**

#### Reconciliação Contábil
- **`POST /wallets/:walletId/reconciliation`**
- **Resposta (200 OK):**
  ```json
  {
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "storedBalance": { "amount": "1000.00", "currency": "BRL" },
    "calculatedBalance": { "amount": "1000.00", "currency": "BRL" },
    "difference": { "amount": "0.00", "currency": "BRL" },
    "consistent": true,
    "checkedEntries": 1
  }
  ```

---

### 2. Transações de Apostas (`/wagering`)

> 📖 **Documentação de Fluxo**: Para visualizar diagramas de sequência, fluxograma de decisão e o ciclo de vida completo dos dados (PostgreSQL + SQS FIFO), consulte [docs/wagering-transactions-flow.md](docs/wagering-transactions-flow.md).

#### Submeter Transação de Aposta
- **`POST /wagering/transactions`**
- **Header Obrigatório:** `Idempotency-Key: provider-a:tx-100`
- **Payload:**
  ```json
  {
    "providerId": "provider-a",
    "externalTransactionId": "tx-100",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
  ```
- **Resposta (200 OK):**
  ```json
  {
    "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
    "status": "PROCESSED",
    "balance": { "amount": "975.00", "currency": "BRL" },
    "idempotentReplay": false
  }
  ```

#### Consultar Transação
- **`GET /wagering/transactions/:transactionId`**
- **`GET /providers/:providerId/wagering/transactions/:externalTransactionId`**

---

### 3. Health Checks (`/health`)

- **`GET /health/live`** — Processo em execução.
- **`GET /health/ready`** — Testa conectividade ativa com PostgreSQL e LocalStack SQS FIFO.

---

### 4. Observabilidade e Métricas (`/metrics`)

Endpoints dedicados para monitoramento em tempo real da saúde financeira e operacional do processador:

#### Snapshot Consolidado
- **`GET /metrics`**
- **Resposta (200 OK):**
  ```json
  {
    "timestamp": "2026-10-11T15:30:00.000Z",
    "uptimeSeconds": 120.5,
    "transactions": {
      "byStatus": {
        "PROCESSED": 45,
        "REJECTED": 5,
        "PENDING_REFERENCE": 2,
        "FAILED": 0,
        "PENDING": 0
      },
      "total": 52
    },
    "idempotency": {
      "duplicatesDetected": 8
    },
    "concurrency": {
      "lockConflicts": 3
    },
    "retries": {
      "sqsConsumerRetries": 1,
      "outboxRetries": 2,
      "pendingReferencesRetries": 4,
      "total": 7
    },
    "messaging": {
      "dlq": {
        "approximateNumberOfMessages": 0,
        "approximateNumberOfMessagesNotVisible": 0,
        "status": "connected"
      },
      "outboxLag": {
        "pendingCount": 0,
        "oldestPendingAgeSeconds": 0
      }
    },
    "latency": {
      "transactionProcessingMs": {
        "count": 52,
        "min": 4.2,
        "avg": 14.5,
        "max": 85.1,
        "p50": 12.0,
        "p95": 32.5,
        "p99": 68.0
      }
    }
  }
  ```

#### Endpoints Específicos
- **`GET /metrics/transactions`** — Detalhamento de transações por status, duplicatas detectadas e conflitos de concorrência.
- **`GET /metrics/messaging`** — Monitoramento de filas (mensagens na DLQ, Outbox lag e retries por componente).
- **`GET /metrics/latency`** — Estatísticas de latência de processamento de transações com percentis (`p50`, `p95`, `p99`, `avg`, `min`, `max`).
- **`GET /metrics/prometheus`** — Exportação no formato texto padrão Prometheus (`text/plain; version=0.0.4`) para integração com Prometheus e Grafana.

