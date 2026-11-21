# Proposal

## Why

A capacidade de carteiras (`wallets`) já está implementada e em operação no projeto, mas `openspec/specs/` ainda não possui especificações baseline registradas. Formalizar a especificação baseline de `wallets` com base fiel no comportamento atual estabelece uma fonte de verdade durável para rastreabilidade, revisão arquitetural e evolução controlada por futuras changes.

## What Changes

- Criação da especificação baseline da capacidade `wallets` em `specs/wallets/spec.md`, retratando estritamente os contratos HTTP, regras de domínio, invariantes financeiras, garantias de concorrência, imutabilidade do ledger, eventos de integração e comportamentos observáveis atualmente implementados.
- Documentação da arquitetura vigente (*as-is*) em `design.md`, cobrindo camadas de domínio, portas, casos de uso, persistência, limites transacionais, estratégia de lock por `walletId` e constraints no PostgreSQL.
- Registro formal de 5 ressalvas observadas durante a análise da implementação atual (para endereçamento em changes futuras dedicadas, sem alterar o comportamento vigente nesta change):
  1. Corrida concorrente de criação duplicada em `POST /wallets` (violação de `uq_wallets_player_currency` retorna `500 Internal Server Error` em vez de `409 Conflict`).
  2. Tratamento de `cursor` inválido em `GET /wallets/:walletId/ledger` (Base64/JSON malformado é ignorado silenciosamente retornando a primeira página; JSON decodificado com `createdAt`/`id` inválidos gera `500 Internal Server Error`).
  3. Reconciliação em `POST /wallets/:walletId/reconciliation` executada em duas leituras independentes fora de snapshot transacional comum e sem contabilização de métrica para divergências no `MetricsService`.
  4. Fronteira de integração com `wagering` na abertura de carteira com saldo inicial positivo (`OPENING`).
  5. Lacunas de cobertura automatizada para `GetWalletLedgerUseCase`, paginação por `cursor`, camada HTTP de `WalletController`, outbox na abertura e constraints secundárias no PostgreSQL.
- Definição de checklist em `tasks.md` para verificação de aderência da baseline aos arquivos e testes existentes e posterior sincronização para `openspec/specs/wallets/spec.md`.

### Fora de escopo

- Alterações em código-fonte de aplicação, domínio ou infraestrutura (`src/**`).
- Criação, edição ou refatoração de testes automatizados (`tests/**`).
- Correção imediata das ressalvas mapeadas acima (cada correção deverá ser proposta e implementada em change própria após a baseline).
- Especificação das operações de apostas e liquidação (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`), que pertencem à futura especificação da capacidade `wagering` (preservando aqui apenas o efeito observável da transação interna `OPENING` gerada na criação de carteira com saldo inicial positivo).
- Implementação de autenticação/autorização via Identity Provider externo (OIDC/OAuth2).

## Capabilities

### New Capabilities
- `wallets`: Gerenciamento do ciclo de vida de carteiras por `(playerId, currency)`, representação monetária decimal exata (`Money`), mutações de saldo com versionamento e concorrência serializada por `walletId`, ledger contábil imutável (*append-only*) com extrato paginado por cursor opaco, reconciliação contábil e emissão atômica de eventos de integração via outbox na abertura com saldo positivo.

### Modified Capabilities
<!-- Nenhuma capacidade existente modificada; trata-se da criação da especificação baseline de wallets. -->

## Impact

- **Migrations de banco de dados**: nenhum impacto; não há criação ou alteração de migrations nem de schema SQL (mantém integralmente a migration `1700000000000-initial-schema.ts` e as tabelas `wallets`, `wallet_ledger_entries`, `wager_transactions` e `outbox_messages`).
- **Compatibilidade de API HTTP e mensagens SQS**: sem alterações ou quebras (`0` breaking changes); os endpoints `POST /wallets`, `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger` e `POST /wallets/:walletId/reconciliation`, bem como os payloads dos eventos `WalletBalanceChanged` e `WagerTransactionProcessed`, permanecem 100% compatíveis com o estado atual.
- **Novas dependências**: nenhuma dependência adicionada ao `package.json`.
- **Artefatos afetados**: apenas arquivos de planejamento em `openspec/changes/add-wallets-baseline-spec/` (e posteriormente `openspec/specs/wallets/spec.md` após sincronização/arquivamento).
