# Plano de Implementação — Distributed Wagering Processor

Este documento apresenta o planejamento arquitetural e de engenharia detalhado para a implementação completa do sistema financeiro distribuído de processamento de apostas, em conformidade com as diretrizes de [project-scope.md](file:///c:/Users/jesse/portfolio/repos/pay-challenge/docs/project-scope.md), [database-modeling.md](file:///c:/Users/jesse/portfolio/repos/pay-challenge/docs/database-modeling.md) e as melhores práticas do NestJS, Clean Architecture, SOLID e DDD.

---

## 1. Visão Geral da Arquitetura

O sistema será construído seguindo uma **Clean Architecture / Ports & Adapters** estrita com **Domain-Driven Design (DDD)**:

```text
src/
├── domain/                          # Núcleo de Domínio Puro (Zero dependências externas)
│   ├── shared/
│   │   ├── money.value-object.ts    # VO monetário imutável com decimal.js
│   │   └── canonical-json.util.ts   # Hash SHA-256 canônico para idempotência
│   ├── wallet/
│   │   ├── wallet.aggregate.ts      # Agregado da Carteira (saldo, version, invariantes)
│   │   └── wallet-ledger.entity.ts  # Entrada de Ledger imutável (append-only)
│   ├── wagering/
│   │   ├── wager-transaction.aggregate.ts # Transação de aposta e máquina de estados
│   │   ├── wager-transaction-kind.enum.ts
│   │   ├── wager-transaction-status.enum.ts
│   │   └── failure-code.enum.ts     # Taxonomia padronizada de falhas de negócio
│   └── messaging/
│       ├── inbox-message.entity.ts  # Deduplicação de consumo SQS
│       ├── outbox-message.entity.ts # Registro persistente de eventos
│       └── integration-event.abstract.ts # Base class para eventos de integração
│
├── application/                     # Casos de Uso, DTOs e Portas
│   ├── ports/
│   │   ├── wallet.repository.port.ts
│   │   ├── wallet-ledger.repository.port.ts
│   │   ├── wager-transaction.repository.port.ts
│   │   ├── inbox.repository.port.ts
│   │   ├── outbox.repository.port.ts
│   │   ├── unit-of-work.port.ts     # Transação atômica & locks de banco
│   │   └── sqs-publisher.port.ts    # Porta para despacho de mensagens
│   ├── dtos/                        # DTOs validados via class-validator & class-transformer
│   │   ├── money.dto.ts             # Validação estrita de valor decimal e ISO currency
│   │   ├── create-wallet.dto.ts
│   │   ├── submit-wager-transaction.dto.ts
│   │   ├── ledger-query.dto.ts
│   │   ├── reconciliation-result.dto.ts
│   │   └── sqs-wager-message.dto.ts # Validação de payload para mensagens da fila
│   └── use-cases/
│       ├── create-wallet.use-case.ts
│       ├── get-wallet.use-case.ts
│       ├── get-wallet-ledger.use-case.ts
│       ├── get-wager-transaction.use-case.ts
│       ├── process-wager-transaction.use-case.ts # Core financeiro e idempotência
│       ├── reconcile-wallet.use-case.ts
│       └── reprocess-pending-references.use-case.ts
│
├── infrastructure/                  # Implementações Técnicas e Adaptadores
│   ├── persistence/
│   │   ├── data-source.ts           # TypeORM DataSource alimentado pelas ENVs
│   │   ├── persistence.module.ts
│   │   ├── entities/                # Mapeamento Data Mapper TypeORM
│   │   │   ├── wallet.orm-entity.ts
│   │   │   ├── wallet-ledger.orm-entity.ts
│   │   │   ├── wager-transaction.orm-entity.ts
│   │   │   ├── inbox-message.orm-entity.ts
│   │   │   └── outbox-message.orm-entity.ts
│   │   ├── repositories/            # Implementação das portas com TypeORM
│   │   │   ├── typeorm-wallet.repository.ts
│   │   │   ├── typeorm-wallet-ledger.repository.ts
│   │   │   ├── typeorm-wager-transaction.repository.ts
│   │   │   ├── typeorm-inbox.repository.ts
│   │   │   ├── typeorm-outbox.repository.ts
│   │   │   └── typeorm-unit-of-work.ts
│   │   └── migrations/              # Migration DDL reversível com constraints e triggers
│   │       └── 1700000000000-initial-schema.ts
│   ├── messaging/
│   │   ├── messaging.module.ts
│   │   ├── sqs/
│   │   │   ├── sqs-publisher.service.ts
│   │   │   └── sqs-consumer.service.ts
│   │   └── jobs/
│   │       ├── outbox-publisher.job.ts          # FOR UPDATE SKIP LOCKED
│   │       └── pending-references.job.ts
│   ├── http/
│   │   ├── http.module.ts
│   │   ├── controllers/
│   │   │   ├── wallet.controller.ts
│   │   │   ├── wagering.controller.ts
│   │   │   └── health.controller.ts
│   │   ├── filters/
│   │   │   └── http-exception.filter.ts         # Mapeamento preciso de status HTTP
│   │   └── interceptors/
│   │       └── logging.interceptor.ts           # Correlation ID & JSON logs
│   └── config/
│       └── env.config.ts                        # Leitura tipada das variáveis de ambiente
│
├── main.ts
└── app.module.ts
```

---

## 2. Etapas Detalhadas de Implementação

### Etapa 1: Configuração do Projeto, Dependências e Ajuste de Compilação
1. **Instalação das Bibliotecas de Validação**:
   - Adicionar `class-validator` e `class-transformer`:
     ```bash
     bun add class-validator class-transformer
     ```
2. **`tsconfig.json`**:
   - Ativar `experimentalDecorators: true` e `emitDecoratorMetadata: true` para suportar plenamente os decorators do NestJS, TypeORM e `class-validator`.
3. **`package.json`**:
   - Configurar scripts de execução:
     - `"start"`: `bun run src/main.ts`
     - `"start:dev"`: `bun --watch src/main.ts`
     - `"test"`: `bun test`
     - `"typeorm"`: `bun run typeorm`
     - `"migration:run"`: executar migrations via DataSource.

### Etapa 2: Módulo de Configuração de Ambiente
1. Criar helper centralizado de configuração `src/infrastructure/config/env.config.ts`:
   - Mapear variáveis de ambiente:
     - PostgreSQL: `POSTGRES_PAY_CHALLENGE_DB`, `POSTGRES_PAY_CHALLENGE_USER`, `POSTGRES_PAY_CHALLENGE_PASSWORD`, `POSTGRES_HOST` (default `localhost`), `POSTGRES_PORT` (default `5432`).
     - SQS: `AWS_REGION`, `AWS_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SQS_WAGER_TRANSACTIONS_QUEUE_URL`, `SQS_WAGER_TRANSACTIONS_DLQ_URL`.

### Etapa 3: Modelagem do Domínio (DDD Puro)
1. **Value Object `Money`** (`src/domain/shared/money.value-object.ts`):
   - Imutável, utilizando `decimal.js`.
   - Escala fixa de 2 casas decimais (`toFixed(2)`).
   - Rejeição estrita de entradas com formato incorreto (`NaN`, `Infinity`, mais de 2 casas decimais, notação científica, valores negativos onde proibido).
   - Operações: `add`, `subtract`, `negate`, `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`.
   - Comparação e bloqueio de operações entre moedas distintas (`assertSameCurrency`).
2. **Hash Canônico de Payload** (`src/domain/shared/canonical-json.util.ts`):
   - Serialização de objeto ordenando recursivamente todas as chaves em ordem alfabética.
   - Geração de hash SHA-256 hexadecimal estável.
3. **Agregado `Wallet`** (`src/domain/wallet/wallet.aggregate.ts`):
   - Factories estáticas `open()` e `rehydrate()`.
   - Invariantes: saldo nunca negativo, controle de versão (`version` incrementa exclusivamente a cada mutação de saldo).
   - Métodos de aplicação de saldo: `credit()` e `debit()`.
4. **Entidade `WalletLedgerEntry`** (`src/domain/wallet/wallet-ledger.entity.ts`):
   - Estruturalmente imutável (sem setters, sem métodos de alteração).
   - Factory estática `create()` validando a consistência contábil:
     - `CREDIT`: `balanceAfter === balanceBefore.add(amount)`
     - `DEBIT`: `balanceAfter === balanceBefore.subtract(amount)`
5. **Agregado `WagerTransaction`** (`src/domain/wagering/wager-transaction.aggregate.ts`):
   - Máquina de estados:
     - Transições para `PROCESSED`, `REJECTED`, `FAILED` são terminais (lançam exceção se o estado atual for terminal).
     - Estado `PENDING_REFERENCE` para transações `REFUND` ou `ROLLBACK` cuja referência ainda não existe no sistema.
   - Enums: `WagerTransactionKind` (`OPENING`, `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`), `WagerTransactionStatus`, `FailureCode`.
   - Validações: `OPENING` é de uso estritamente interno; `REFUND` exige referência a um `BET`; `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`.
6. **Entidades de Mensageria e Eventos de Integração**:
   - `InboxMessage`: deduplicação por `(consumerName, messageId)`.
   - `OutboxMessage`: registro persistente de eventos com contagem de tentativas e agendamento de backoff.
   - Classe abstrata `IntegrationEvent<T>` e eventos concretos:
     - `WalletBalanceChanged`
     - `WagerTransactionProcessed`
     - `WagerTransactionRejected`
     - `WagerTransactionPendingReference`

### Etapa 4: Camada de Validação de DTOs (`class-validator` & `class-transformer`)
1. **Configuração Global do NestJS `ValidationPipe`** (`src/main.ts`):
   ```typescript
   app.useGlobalPipes(
     new ValidationPipe({
       whitelist: true,              // Remove propriedades não declaradas no DTO
       forbidNonWhitelisted: true,   // Rejeita a requisição com 400 se houver propriedades extras
       transform: true,              // Converte payloads para instâncias tipadas das classes DTO
       stopAtFirstError: false,      // Retorna todos os erros de validação acumulados
     }),
   );
   ```
2. **Definição dos DTOs com Regras Estritas**:
   - **`MoneyDto`** (`src/application/dtos/money.dto.ts`):
     - `@IsString()`
     - `@Matches(/^\d+(\.\d{2})$/, { message: 'amount deve ser uma string decimal estrita com 2 casas (ex: "25.00") e não pode ser negativo nem notação científica' })`
     - `@IsISO4217({ message: 'currency deve ser um código ISO-4217 válido (ex: BRL)' })`
   - **`CreateWalletDto`** (`src/application/dtos/create-wallet.dto.ts`):
     - `playerId`: `@IsUUID('all', { message: 'playerId deve ser um UUID válido' })`
     - `initialBalance`: `@ValidateNested()`, `@Type(() => MoneyDto)`, `@IsDefined()`
   - **`SubmitWagerTransactionDto`** (`src/application/dtos/submit-wager-transaction.dto.ts`):
     - `providerId`: `@IsString()`, `@IsNotEmpty()`
     - `externalTransactionId`: `@IsString()`, `@IsNotEmpty()`
     - `playerId`: `@IsUUID('all')`
     - `walletId`: `@IsUUID('all')`
     - `roundId`: `@IsString()`, `@IsNotEmpty()`
     - `gameId`: `@IsString()`, `@IsNotEmpty()`
     - `kind`: `@IsEnum(WagerTransactionKind, { message: 'kind deve ser BET, WIN, LOSS, REFUND ou ROLLBACK' })` (bloqueando `OPENING`, que é estritamente interno)
     - `money`: `@ValidateNested()`, `@Type(() => MoneyDto)`, `@IsDefined()`
     - `referenceExternalTransactionId`: `@IsOptional()`, `@IsString()`, `@IsNotEmpty()`
   - **`LedgerQueryDto`** (`src/application/dtos/ledger-query.dto.ts`):
     - `cursor`: `@IsOptional()`, `@IsString()`
     - `limit`: `@IsOptional()`, `@Type(() => Number)`, `@IsInt()`, `@Min(1)`, `@Max(100)`
   - **`SqsWagerMessageDto`** (`src/application/dtos/sqs-wager-message.dto.ts`):
     - Validação estrutural do envelope SQS (`messageId`, `type`, `occurredAt`, `data`) executada via `plainToInstance` + `validateOrReject` antes de processar no consumidor da fila.
   - **Validação de Header HTTP `Idempotency-Key`**:
     - Header obrigatório nos endpoints de mutação, validado via Decorator / Guard dedicado com rejeição `400 Bad Request` se ausente ou em branco.

### Etapa 5: Camada de Persistência (TypeORM & Migrations)
1. **Configuração do DataSource** (`src/infrastructure/persistence/data-source.ts`):
   - Configurado para PostgreSQL com suporte a pooling e execução via CLI e NestJS.
2. **Entidades TypeORM (Data Mapper)**:
   - `WalletOrmEntity`: mapeia colunas `id`, `player_id`, `currency`, `balance_amount` (`NUMERIC(18, 2)`), `version`, `created_at`, `updated_at`. Métodos de conversão `toDomain()` e `fromDomain()`.
   - `WalletLedgerOrmEntity`: mapeia lançamentos contábeis.
   - `WagerTransactionOrmEntity`: mapeia transações financeiras.
   - `InboxMessageOrmEntity` e `OutboxMessageOrmEntity`.
3. **Migration Versionada** (`src/infrastructure/persistence/migrations/`):
   - DDL exato com as restrições especificadas em [database-modeling.md](file:///c:/Users/jesse/portfolio/repos/pay-challenge/docs/database-modeling.md):
     - `CONSTRAINT chk_wallets_balance_non_negative CHECK (balance_amount >= 0)`
     - `CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)`
     - `CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id)`
     - `CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key)`
     - `CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id)`
     - `CONSTRAINT chk_ledger_balanced CHECK (...)`
     - Trigger PostgreSQL `trg_prevent_ledger_mutation` bloqueando `UPDATE` e `DELETE` em `wallet_ledger_entries`.
     - Índice parcial de reversão única: `uq_wager_tx_single_reversal`.
     - Índice otimizado para o worker de outbox: `idx_outbox_pending_polling` em `WHERE published_at IS NULL`.
4. **Implementação do Unit of Work / Transaction Manager**:
   - `TypeOrmUnitOfWork`: gerencia `QueryRunner`, `startTransaction`, `commitTransaction`, `rollbackTransaction` e execução sob `lock: { mode: 'pessimistic_write' }` (`SELECT ... FOR UPDATE`).
   - Repositórios implementando as portas da aplicação.

### Etapa 6: Casos de Uso (Camada de Aplicação)
1. **`CreateWalletUseCase`**:
   - Criação da carteira.
   - Se `initialBalance > 0`: executa dentro de transação atômica a criação de transação interna `OPENING` + lançamento contábil `CREDIT` no ledger.
   - Lança erro 409 (conflito) caso já exista wallet para `(playerId, currency)`.
2. **`ProcessWagerTransactionUseCase`** (Orquestrador Central):
   - Passo 1: Calcular `payloadHash` do JSON canônico.
   - Passo 2: Iniciar transação no `UnitOfWork`.
   - Passo 3: Checar idempotência:
     - Se transação já existe com mesma chave e mesmo hash: retornar o resultado original persistido (`idempotentReplay: true`).
     - Se transação já existe com hash divergente: lançar conflito de idempotência (`IDEMPOTENCY_PAYLOAD_MISMATCH`).
   - Passo 4: Se requisição vier de SQS, registrar `InboxMessage` na transação para deduplicação atômica.
   - Passo 5: Buscar a carteira executando **Lock Pessimista** (`pessimistic_write` -> `SELECT ... FOR UPDATE`).
   - Passo 6: Validar regras de negócio específicas para cada `kind`:
     - `BET`: verificar saldo suficiente. Se insuficiente, transicionar transação para `REJECTED` com `INSUFFICIENT_FUNDS`, emitir evento `WagerTransactionRejected` e comitar sem alterar saldo/ledger.
     - `WIN`: aplicar crédito na carteira, gerar ledger `CREDIT`.
     - `LOSS`: registrar transação como `PROCESSED`, não altera saldo nem ledger.
     - `REFUND`: buscar a transação referenciada (`providerId`, `referenceExternalTransactionId`). Se não encontrada, marcar como `PENDING_REFERENCE`. Se encontrada, validar se é `BET` e se pertence à mesma rodada, moeda e valor; se já revertida, rejeitar (`TRANSACTION_ALREADY_REVERSED`); aplicar crédito e registrar ledger `CREDIT`.
     - `ROLLBACK`: buscar a transação referenciada. Se ausente, marcar como `PENDING_REFERENCE`. Se presente, inverter a direção financeira (`BET` -> crédito, `WIN` -> débito). Se débito e saldo insuficiente, rejeitar explicitamente com `INSUFFICIENT_FUNDS_FOR_REVERSAL`.
   - Passo 7: Salvar carteira atualizada (incrementando `version`), salvar lançamento no ledger, salvar transação como `PROCESSED` e registrar eventos na `OutboxMessage`.
   - Passo 8: Comitar a transação SQL.
3. **`ReconcileWalletUseCase`**:
   - Somar algebricamente todos os lançamentos de `wallet_ledger_entries` para a wallet: `balance_before` inicial + somatório de créditos - somatório de débitos.
   - Comparar com o saldo materializado corrente em `wallets.balance_amount`.
   - Retornar objeto com `consistent`, `difference`, `checkedEntries`.
4. **`GetWalletLedgerUseCase`**:
   - Consulta paginada do ledger ordenada por `(created_at DESC, id DESC)`.
   - Retornar cursor opaco baseado em base64 com timestamp e ID para paginação estável.
5. **`ReprocessPendingReferencesUseCase`**:
   - Polling de transações `PENDING_REFERENCE`.
   - Tentativa de resolução da referência e reprocessamento com limite de retentativas.

### Etapa 7: Mensageria Assíncrona e Transactional Outbox
1. **Publicador e Consumidor SQS**:
   - `SqsPublisherService`: integração com `@aws-sdk/client-sqs` utilizando as URLs das filas definidas nas variáveis de ambiente.
   - `SqsConsumerService`: polling com loop assíncrono em `wager-transactions.fifo`, desserialização e validação com `SqsWagerMessageDto`, chamada ao `ProcessWagerTransactionUseCase`, deduplicação no inbox e `DeleteMessageCommand` (ACK) **exclusivamente após o commit**.
   - Em caso de falha transitória: não realizar ACK (permitindo retry com backoff ou DLQ após 3 tentativas configuradas no LocalStack).
   - Tratamento de `SIGTERM` para encerramento gracioso (concluir a mensagem corrente antes de encerrar o processo).
2. **Job Publicador da Outbox (`OutboxPublisherJob`)**:
   - Execução em intervalo curto (ex: a cada 1 segundo).
   - Query atômica multi-instância:
     ```sql
     SELECT * FROM outbox_messages
     WHERE published_at IS NULL
       AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
     ORDER BY occurred_at ASC
     LIMIT 50
     FOR UPDATE SKIP LOCKED;
     ```
   - Publicar no SQS/EventBridge e marcar `published_at = NOW()`.
   - Em caso de erro de rede/SQS: incrementar `attempts` e agendar `next_attempt_at` com backoff exponencial.

### Etapa 8: Camada HTTP e Observabilidade
1. **Controllers NestJS**:
   - `WalletController`:
     - `POST /wallets` (valida com `CreateWalletDto`)
     - `GET /wallets/:walletId` (valida `:walletId` com `ParseUUIDPipe`)
     - `GET /wallets/:walletId/ledger` (valida com `LedgerQueryDto`)
     - `POST /wallets/:walletId/reconciliation`
   - `WageringController`:
     - `POST /wagering/transactions` (valida com `SubmitWagerTransactionDto` + header `Idempotency-Key`)
     - `GET /wagering/transactions/:transactionId` (valida com `ParseUUIDPipe`)
     - `GET /providers/:providerId/wagering/transactions/:externalTransactionId`
   - `HealthController`:
     - `GET /health/live` (processo ativo)
     - `GET /health/ready` (valida conexão ativa com PostgreSQL e AWS SQS via LocalStack)
2. **Tratamento de Exceções & Mapeamento HTTP**:
   - Validação inválida / sintaxe (falha no `ValidationPipe`): `400 Bad Request` com array de mensagens descritivas
   - Conflito de Idempotência (mesma key, payload diferente): `409 Conflict`
   - Wallet já existente: `409 Conflict`
   - Recurso não encontrado: `404 Not Found`
   - Rejeição de regra de negócio (ex: saldo insuficiente, rodada inválida): `422 Unprocessable Entity` com corpo estruturado contendo `failureCode`
   - Aceito em processamento assíncrono / pendência de referência: `202 Accepted`
   - Sucesso com processamento imediato: `200 OK` / `201 Created`
3. **Observabilidade e Logs**:
   - Logs formatados em JSON contendo `correlationId`, `transactionId`, `walletId`, `providerId`.
   - Não expor informações confidenciais ou segredos em logs.

### Etapa 9: Testes Automatizados
1. **Testes Unitários (`tests/unit/`)**:
   - `money.value-object.spec.ts`: precisão de `decimal.js`, rejeição de float impreciso, validação de 2 casas, moedas incompatíveis.
   - `wallet.aggregate.spec.ts`: garantia de saldo `>= 0`, incrementação estrita de `version`.
   - `wallet-ledger.entity.spec.ts`: verificação da equação contábil `balanceBefore ± amount === balanceAfter`.
   - `wager-transaction.aggregate.spec.ts`: transições de estado, validação de `kind` e referência.
   - `process-wager-transaction.use-case.spec.ts`: testes de unidade dos fluxos de `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`, idempotência repetida vs payload conflitante.
   - `dto-validation.spec.ts`: testes de validação dos DTOs com `class-validator` (rejeitando strings decimais com 3 casas, notação científica, NaN, enums inválidos, payloads com campos não permitidos).
2. **Testes de Integração e Concorrência (`tests/integration/` e `tests/concurrency/`)**:
   - Verificação das constraints no PostgreSQL real.
   - Teste de idempotência e redelivery com SQS LocalStack.
   - Teste de concorrência: 50 requisições simultâneas da mesma aposta resultando em exatamente 1 débito.
   - Teste de concorrência com 2 apostas de 80.00 disputando saldo de 100.00: 1 aceita, 1 rejeitada por saldo insuficiente, saldo final 20.00.
   - Validação da invariante contábil: `wallet.balance == soma do ledger`.

---

## 3. Próximos Passos Imediatos após Aprovação

1. Instalar `class-validator` e `class-transformer` e ajustar `tsconfig.json` e `package.json`.
2. Implementar a camada de Domínio Puro (`Money`, `Wallet`, `WalletLedgerEntry`, `WagerTransaction`, eventos de integração).
3. Implementar a camada de DTOs com validações completas do `class-validator`.
4. Criar a camada de Persistência TypeORM e a migration inicial com as constraints e triggers PostgreSQL.
5. Implementar os casos de uso da aplicação com controle de transação e lock pessimista.
6. Implementar a camada HTTP (Controllers, Exception Filters, Pipes) e os serviços de mensageria SQS / Outbox.
7. Rodar os testes unitários e validar os fluxos contra o banco e SQS do ambiente local.
