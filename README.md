# Distributed Wagering Processor

Serviço financeiro distribuído de alta consistência para processamento de apostas de múltiplos provedores de jogos, implementado com **Bun**, **TypeScript**, **NestJS**, **TypeORM**, **PostgreSQL** e **AWS SQS FIFO (LocalStack)**.

---

## 🚀 Tecnologias e Arquitetura

- **Runtime & Test Runner**: [Bun 1.x](https://bun.sh)
- **Framework**: [NestJS](https://nestjs.com)
- **ORM & Banco de Dados**: [TypeORM](https://typeorm.io) com [PostgreSQL](https://www.postgresql.org)
- **Mensageria**: AWS SQS FIFO emulado via [LocalStack](https://localstack.cloud)
- **Arquitetura**: Clean Architecture (Ports & Adapters) + DDD (Domain-Driven Design)
- **Padrões de Resiliência**: Transactional Inbox, Transactional Outbox com `FOR UPDATE SKIP LOCKED`, Lock Pessimista por Carteira (`SELECT ... FOR UPDATE`), Idempotência Persistente baseada em Hash Canônico SHA-256.

Consulte o documento completo de decisões técnicas em [ARCHITECTURE.md](ARCHITECTURE.md).

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
Aplica o schema completo, constraints `CHECK`, índices únicos parciais e o trigger de imutabilidade do ledger:
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

### 3. Health Checks

- **`GET /health/live`** — Processo em execução.
- **`GET /health/ready`** — Testa conectividade ativa com PostgreSQL e LocalStack SQS FIFO.
