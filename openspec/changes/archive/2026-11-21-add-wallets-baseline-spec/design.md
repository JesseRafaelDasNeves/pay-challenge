# Design

## Context

Este documento registra o desenho arquitetural vigente (*as-is*) da capacidade `wallets` descrita em `proposal.md` e `specs/wallets/spec.md`, sem introduzir alterações de código-fonte, contratos ou schema. A arquitetura segue Clean Architecture / Arquitetura Hexagonal (Ports & Adapters) + DDD sobre Bun (`bun test`), TypeScript estrito ESM (imports relativos com sufixo `.js`), NestJS, TypeORM e PostgreSQL.

## Goals / Non-Goals

**Goals:**
- Documentar fielmente os limites entre domínio puro, casos de uso dedicados, portas e adaptadores de persistência/HTTP da capacidade `wallets`.
- Registrar os limites transacionais (`UnitOfWorkPort` / `TypeOrmUnitOfWork`), a estratégia de lock pessimista por `walletId`, a atomicidade com `outbox_messages` e as constraints/triggers já existentes no PostgreSQL.
- Formalizar as 5 ressalvas técnicas identificadas na análise da implementação atual para orientar changes futuras de hardening e ampliação de testes.

**Non-Goals:**
- Alterar código de produção, DTOs, repositórios, controllers ou suítes de testes existentes.
- Criar novas migrations ou alterar tabelas, índices, constraints e triggers do banco de dados.
- Modelar regras de negócio específicas de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`), que pertencem à futura especificação de `wagering`.

## Decisions

### 1. Isolamento total do núcleo de domínio (`src/domain/`)
- **Decisão**: Manter `Money` (`src/domain/shared/money.value-object.ts`), `Wallet` (`src/domain/wallet/wallet.aggregate.ts`), `WalletLedgerEntry` (`src/domain/wallet/wallet-ledger.entity.ts`), `LedgerDirection` (`src/domain/wallet/ledger-direction.enum.ts`) e `WalletBalanceChanged` (`src/domain/messaging/integration-event.abstract.ts`) 100% livres de imports ou decorators de NestJS, TypeORM ou AWS SDK.
- **Modelagem de agregados e entidades**: Construtores `private` com factories estáticas explícitas (`Money.from`, `Money.zero`, `Wallet.open`, `Wallet.rehydrate`, `WalletLedgerEntry.create`, `WalletLedgerEntry.rehydrate`). As factories de reidratação reconstroem o estado persistido sem reexecutar validações de transição, enquanto `Wallet.debit`, `Wallet.credit` e `WalletLedgerEntry.create` protegem as invariantes financeiras (moeda única, estrita positividade, saldo não negativo e equação `balanceBefore ± amount = balanceAfter`).
- **Aritmética monetária**: `Money` encapsula `decimal.js` com escala fixa de 2 casas decimais (`toFixed(2)`) e código ISO-4217 em maiúsculas, eliminando o uso de `number`/`float`/`double`.
- **Alternativa considerada**: Acoplar entidades de domínio diretamente a decorators ORM (Active Record). Rejeitada por violar o isolamento do domínio, dificultar testes unitários em memória e misturar preocupações de persistência com regras contábeis.

### 2. Casos de uso dedicados por operação e inversão de dependência (SOLID)
- **Decisão**: Cada operação HTTP de `WalletController` (`src/infrastructure/http/controllers/wallet.controller.ts`) delega a um único Use Case coeso em `src/application/use-cases/`:
  - `CreateWalletUseCase` (`create-wallet.use-case.ts`): `POST /wallets`
  - `GetWalletUseCase` (`get-wallet.use-case.ts`): `GET /wallets/:walletId`
  - `GetWalletLedgerUseCase` (`get-wallet-ledger.use-case.ts`): `GET /wallets/:walletId/ledger`
  - `ReconcileWalletUseCase` (`reconcile-wallet.use-case.ts`): `POST /wallets/:walletId/reconciliation`
- **Ports & Adapters**: A camada `application` depende apenas das abstrações em `src/application/ports/` (`WALLET_REPOSITORY_PORT` / `WalletRepositoryPort`, `WALLET_LEDGER_REPOSITORY_PORT` / `WalletLedgerRepositoryPort`, `UNIT_OF_WORK_PORT` / `UnitOfWorkPort`), implementadas na camada de infraestrutura via padrão Data Mapper (`WalletOrmEntity`, `WalletLedgerOrmEntity`, `TypeOrmWalletRepository`, `TypeOrmWalletLedgerRepository`, `TypeOrmUnitOfWork`).
- **Validação de fronteira**: `ValidationPipe` global em `src/main.ts` (`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`, `stopAtFirstError: false`) com `CreateWalletDto`, `MoneyDto` e `LedgerQueryDto`, `ParseUUIDPipe` nos parâmetros `:walletId` e formatação uniforme de erros via `HttpExceptionFilter`.

### 3. Limites transacionais, concorrência por `walletId` e impacto em Inbox/Outbox
- **Estratégia de concorrência**: A unidade de concorrência é o `walletId`. Toda mutação de saldo sobre uma carteira existente ocorre dentro de `UnitOfWorkPort.executeInTransaction` (`TypeOrmUnitOfWork`), adquirindo lock pessimista de linha em `wallets` via `ctx.wallets.findById(walletId, 'pessimistic_write')` (`SELECT ... FOR UPDATE`). Isso serializa mutações concorrentes na mesma carteira em múltiplas instâncias sem lock global entre carteiras distintas, evitando *lost updates* e saldo negativo.
- **Versionamento**: `Wallet` inicia em `version = 1` e incrementa em `+1` exclusivamente em `debit()`/`credit()` bem-sucedidos.
- **Atomicidade na criação (`CreateWalletUseCase`)**:
  - Antes da transação, consulta `walletRepository.findByPlayerIdAndCurrency(playerId, currency)` e lança `ConflictException` (`409`) se já existir.
  - Dentro de `unitOfWork.executeInTransaction`, salva a `Wallet`.
  - Quando `initialBalance == 0.00`: persiste apenas `wallets`.
  - Quando `initialBalance > 0.00`: na **mesma transação SQL**, persiste `WagerTransaction` interna (`kind = 'OPENING'`, `status = 'PROCESSED'`, `providerId = 'INTERNAL'`, `roundId = 'OPENING'`, `gameId = 'INTERNAL'`, `idempotencyKey = 'internal:opening:<walletId>'`, `payloadHash` via `computePayloadHash`), `WalletLedgerEntry` (`direction = 'CREDIT'`, `balanceBefore = '0.00'`, `balanceAfter = initialBalance`) e duas `OutboxMessage` (`WalletBalanceChanged` v1 com `walletVersion = 1` e `WagerTransactionProcessed` v1).
- **Impacto em Inbox e Outbox**:
  - `inbox_messages`: nenhum impacto nos endpoints HTTP de `wallets` (o Transactional Inbox aplica-se ao consumo SQS em `wagering`).
  - `outbox_messages`: qualquer alteração efetiva de saldo (na abertura `> 0.00` ou em transações processadas de `wagering`) grava `WalletBalanceChanged` na mesma transação SQL em `outbox_messages`, nunca publicando antes do commit.
- **Alternativa considerada**: Optimistic locking puro com retries na aplicação. Lock pessimista por linha (`SELECT ... FOR UPDATE`) foi adotado para evitar loops de retry sob alta contenção na mesma carteira (*hot wallet*) mantendo paralelismo total entre carteiras distintas.

### 4. Garantias no PostgreSQL e reversibilidade de migrations
- **Decisão**: Todas as invariantes financeiras de `wallets` e `wallet_ledger_entries` são impostas também no PostgreSQL pela migration versionada e reversível `1700000000000-initial-schema.ts` (`InitialSchema1700000000000`), sem necessidade de novas migrations nesta baseline:
  - `wallets`: tipos exatos `NUMERIC(18, 2)` + `VARCHAR(3)`, `pk_wallets (id)`, `uq_wallets_player_currency (player_id, currency)`, `chk_wallets_balance_non_negative (balance_amount >= 0)`, `chk_wallets_version_positive (version >= 1)`.
  - `wallet_ledger_entries`: `pk_wallet_ledger_entries (id)`, `fk_ledger_wallet` e `fk_ledger_transaction` (`ON DELETE RESTRICT`), `uq_ledger_wallet_transaction (wallet_id, transaction_id)`, `chk_ledger_direction`, `chk_ledger_amount_positive (amount > 0)`, `chk_ledger_balances_non_negative`, `chk_ledger_balanced`, índice composto `idx_ledger_wallet_cursor (wallet_id, created_at DESC, id DESC)`, função `fn_prevent_ledger_mutation` e trigger `trg_prevent_ledger_mutation` (`BEFORE UPDATE OR DELETE`).
- **Reversibilidade**: O método `down` da migration `InitialSchema1700000000000` remove ordenadamente `outbox_messages`, `inbox_messages`, `trg_prevent_ledger_mutation`, `fn_prevent_ledger_mutation`, `wallet_ledger_entries`, `wager_transactions` e `wallets`.

### 5. Fronteira entre `wallets` e `wagering`
- **Decisão**: A capacidade `wallets` é dona do agregado `Wallet`, do livro contábil `WalletLedgerEntry`, dos endpoints `/wallets/**` e do evento `WalletBalanceChanged`. A abertura de carteira com saldo inicial `> 0.00` interage com `wager_transactions` e `WagerTransactionProcessed` exclusivamente pelo tipo interno `OPENING`; todas as regras de `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`, `PENDING_REFERENCE` e validação externa contra `OPENING` permanecem escopo da futura baseline `wagering`.

## Risks / Trade-offs

1. **[Ressalva 1 — Corrida concorrente na criação duplicada (`POST /wallets`)]**
   `CreateWalletUseCase` verifica `findByPlayerIdAndCurrency` fora de transação e não captura violação de chave única PostgreSQL (`23505` em `uq_wallets_player_currency`). Em requisições paralelas idênticas para o mesmo `(playerId, currency)`, o banco impede a duplicata, porém a requisição perdedora falha com `500 Internal Server Error` em vez de `409 Conflict` → **Mitigação**: Retratar o comportamento atual na baseline e tratar o código `23505` em change futura dedicada para retornar `409 Conflict` de forma determinística.

2. **[Ressalva 2 — Tratamento de `cursor` inválido em `GET /wallets/:walletId/ledger`]**
   `TypeOrmWalletLedgerRepository.findByWalletId` ignora silenciosamente erros de parsing Base64/JSON no `catch` (voltando à primeira página com `200 OK`), mas repassa ao SQL valores decodificados com `createdAt` ou `id` incompatíveis com `TIMESTAMPTZ`/`UUID`, causando `500 Internal Server Error` → **Mitigação**: Documentar exatamente esse comportamento na baseline e planejar change futura para validar estritamente o schema do cursor decodificado (`createdAt` ISO-8601 + `id` UUID) retornando `400 Bad Request`.

3. **[Ressalva 3 — Leituras não atômicas e ausência de métrica na reconciliação (`POST /wallets/:walletId/reconciliation`)]**
   `ReconcileWalletUseCase` executa `walletRepository.findById` e `ledgerRepository.sumEntriesByWalletId` em duas queries independentes fora de transação/snapshot comum (sujeito a falso-positivo de divergência durante movimentações simultâneas) e registra divergências apenas em log (`WALLET_RECONCILIATION_DIVERGENCE`), sem incrementar contador no `MetricsService` → **Mitigação**: Registrar ambas as limitações na baseline e abrir change futura para encapsular a leitura em snapshot consistente (ex.: `REPEATABLE READ`) e expor métrica de divergência via `MetricsCollectorPort`.

4. **[Ressalva 4 — Acoplamento na abertura com saldo positivo (`OPENING`)]**
   `CreateWalletUseCase` instancia `WagerTransaction` (`kind = 'OPENING'`) e grava `WagerTransactionProcessed` diretamente em `outbox_messages` → **Mitigação**: Documentar a fronteira explicitamente nesta spec e manter coerência na futura spec baseline de `wagering` (reforçando que `OPENING` é proibido na API/SQS de apostas).

5. **[Ressalva 5 — Lacunas de cobertura de testes automatizados]**
   Não existem testes automatizados cobrindo `GetWalletLedgerUseCase` / paginação por `cursor` no PostgreSQL, camada HTTP de `WalletController` (incluindo `HttpExceptionFilter` e `ParseUUIDPipe`), persistência em `outbox_messages` na criação de wallet com saldo positivo e algumas constraints secundárias (`uq_ledger_wallet_transaction`, `chk_ledger_amount_positive`, `chk_wallets_version_positive`) → **Mitigação**: Registrar a lacuna no `tasks.md` / roadmap de qualidade para endereçamento em change dedicada de ampliação de testes.
