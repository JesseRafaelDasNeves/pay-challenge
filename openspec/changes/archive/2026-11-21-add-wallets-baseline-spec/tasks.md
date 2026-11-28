# Tasks

## 1. Verificação da Camada de Domínio

- [x] 1.1 Conferir aderência de `Money` (`src/domain/shared/money.value-object.ts`), `Wallet` (`src/domain/wallet/wallet.aggregate.ts`), `WalletLedgerEntry` (`src/domain/wallet/wallet-ledger.entity.ts`), `LedgerDirection` (`src/domain/wallet/ledger-direction.enum.ts`) e `WalletBalanceChanged` (`src/domain/messaging/integration-event.abstract.ts`) aos requisitos de precisão decimal, isolamento sem frameworks, invariantes de saldo/moeda e equação contábil, verificando ausência de imports de infraestrutura e executando `bun test tests/unit/money.value-object.spec.ts tests/unit/wallet.aggregate.spec.ts tests/unit/wallet-ledger.entity.spec.ts`.

## 2. Verificação de Portas, DTOs e Use Cases

- [x] 2.1 Conferir os contratos das portas em `src/application/ports/` (`WalletRepositoryPort`, `WalletLedgerRepositoryPort`, `UnitOfWorkPort`) e DTOs em `src/application/dtos/` (`CreateWalletDto`, `MoneyDto`, `LedgerQueryDto`), verificando validações estritas e executando `bun test tests/unit/dto-validation.spec.ts`.
- [x] 2.2 Conferir os casos de uso dedicados `CreateWalletUseCase`, `GetWalletUseCase`, `GetWalletLedgerUseCase` e `ReconcileWalletUseCase` frente aos cenários descritos em `specs/wallets/spec.md` (incluindo criação com `OPENING` vs. `0.00` e as ressalvas registradas em `design.md`), executando `bun test tests/unit/wallet-use-cases.spec.ts tests/unit/reconcile-wallet.use-case.spec.ts`.

## 3. Verificação da Infraestrutura HTTP, Persistência e Concorrência

- [x] 3.1 Conferir o mapeamento de rotas e respostas em `WalletController` (`src/infrastructure/http/controllers/wallet.controller.ts`), `HttpExceptionFilter` (`src/infrastructure/http/filters/http-exception.filter.ts`) e `ValidationPipe` global (`src/main.ts`) frente aos status HTTP e payloads especificados em `specs/wallets/spec.md`.
- [x] 3.2 Conferir Data Mappers (`WalletOrmEntity`, `WalletLedgerOrmEntity`), repositórios (`TypeOrmWalletRepository`, `TypeOrmWalletLedgerRepository`), `TypeOrmUnitOfWork` e constraints/trigger de `wallets` e `wallet_ledger_entries` na migration `1700000000000-initial-schema.ts`, validando contra o PostgreSQL real via `bun run test:integration` e `bun run test:concurrency` (com infraestrutura Docker ativa).

## 4. Validação da Especificação e Suíte Completa

- [x] 4.1 Executar `openspec validate "add-wallets-baseline-spec" --strict` para confirmar que `proposal.md`, `specs/wallets/spec.md`, `design.md` e `tasks.md` passam sem erros nem avisos estruturais.
- [x] 4.2 Executar `bun run test:unit` para confirmar que toda a suíte unitária do projeto passa após a finalização da documentação baseline sem alterações em código ou testes.

## Workflow follow-up

- Sincronizar ou arquivar a change (`openspec-sync-specs` / `openspec-archive-change`) para materializar a spec principal em `openspec/specs/wallets/spec.md` e executar `openspec validate --specs` para confirmar conformidade sem erros.
- Abrir changes dedicadas posteriormente para endereçar as 5 ressalvas registradas em `design.md` (corrida `23505` em `CreateWalletUseCase`, validação de `cursor` no extrato, snapshot consistente e métrica de divergência em `ReconcileWalletUseCase`, especificação baseline complementar de `wagering` para a fronteira `OPENING`, e cobertura de testes automatizados para `GetWalletLedgerUseCase`, `WalletController`, outbox na abertura e constraints secundárias).
