# Spec Delta

## Purpose

Especificar o comportamento observável, os contratos HTTP, as invariantes financeiras, a imutabilidade do ledger, o controle de concorrência e a reconciliação contábil da capacidade `wallets`, retratando fielmente a implementação atual.

## ADDED Requirements

### Requirement: Representação monetária e consistência de moeda
O sistema SHALL representar e aceitar valores monetários apenas com `amount` em string decimal exata de 2 casas decimais e `currency` em código ISO-4217 de 3 letras maiúsculas, realizando cálculos sem ponto flutuante e rejeitando operações entre moedas divergentes.

#### Scenario: Valor monetário válido em contrato
- **WHEN** uma requisição ou operação informa `{ amount, currency }` com `amount` decimal não-negativo de 2 casas decimais (por exemplo, `"25.00"`) e `currency` com 3 letras maiúsculas (por exemplo, `"BRL"`)
- **THEN** o sistema aceita e preserva exatamente a escala de 2 casas decimais em toda aritmética e serialização

#### Scenario: Rejeição de formato monetário ou código de moeda inválido na API
- **WHEN** uma requisição HTTP envia `amount` como número nativo, notação científica, string vazia, valor negativo, quantidade de casas decimais diferente de 2 ou `currency` fora do padrão de 3 letras maiúsculas
- **THEN** o sistema rejeita a requisição com status `400 Bad Request` no formato padrão de erro sem persistir alterações

#### Scenario: Rejeição de operação entre moedas divergentes
- **WHEN** ocorre tentativa de operação aritmética ou movimentação financeira envolvendo moedas distintas
- **THEN** o sistema rejeita a operação por incompatibilidade de moedas e preserva integralmente o saldo e a versão atuais da carteira

### Requirement: Criação de carteira por jogador e moeda
O sistema SHALL permitir a criação de carteiras via `POST /wallets` recebendo `{ playerId, initialBalance }` com no máximo uma carteira por par `(playerId, currency)`, inicializando `version` em `1` e garantindo a unicidade também no schema de banco de dados.

#### Scenario: Criação de carteira com saldo inicial zero
- **WHEN** um cliente envia `POST /wallets` com `playerId` UUID válido, `initialBalance` igual a `"0.00"` em moeda válida e sem propriedades extras
- **THEN** o sistema persiste apenas a carteira com `version = 1`
- **AND** responde `201 Created` com `{ id, playerId, balance: { amount: "0.00", currency }, version: 1 }`
- **AND** não cria registro em `wager_transactions`, `wallet_ledger_entries` nem `outbox_messages`

#### Scenario: Criação de carteira com saldo inicial positivo
- **WHEN** um cliente envia `POST /wallets` com `playerId` UUID válido e `initialBalance.amount` estritamente maior que `"0.00"`
- **THEN** o sistema persiste, na mesma transação atômica, a carteira com `version = 1`, uma transação interna `OPENING` em `wager_transactions` com `status = "PROCESSED"` (`providerId = "INTERNAL"`, `roundId = "OPENING"`, `gameId = "INTERNAL"`, `idempotencyKey = "internal:opening:<walletId>"` e `payloadHash` SHA-256 canônico), um lançamento `CREDIT` em `wallet_ledger_entries` (`balanceBefore = "0.00"`, `balanceAfter = initialBalance`) e dois eventos em `outbox_messages` (`WalletBalanceChanged` v1 com `walletVersion = 1` e `WagerTransactionProcessed` v1)
- **AND** responde `201 Created` com `{ id, playerId, balance, version: 1 }`

#### Scenario: Rejeição de payload inválido na criação de carteira
- **WHEN** um cliente envia `POST /wallets` com `playerId` fora do formato UUID, `initialBalance` ausente ou inválido, ou propriedades não permitidas no corpo da requisição
- **THEN** o sistema responde `400 Bad Request` com `{ statusCode, error, message, path, correlationId, timestamp }`

#### Scenario: Rejeição de carteira duplicada detectada antes da transação
- **WHEN** um cliente envia `POST /wallets` para um par `(playerId, currency)` já existente no banco de dados
- **THEN** o sistema rejeita a criação com `409 Conflict` e não cria nova carteira

#### Scenario: Corrida concorrente na criação de carteira duplicada
- **WHEN** duas requisições `POST /wallets` simultâneas para o mesmo par `(playerId, currency)` ultrapassam a verificação pré-transacional antes do commit
- **THEN** a constraint de unicidade `uq_wallets_player_currency` em `wallets` impede a gravação duplicada no banco de dados
- **AND** a requisição concorrente que falha na constraint retorna atualmente `500 Internal Server Error` sem persistir carteira duplicada (ressalva registrada para futura padronização em `409 Conflict`)

### Requirement: Consulta de carteira por identificador
O sistema SHALL expor a consulta do estado atual de uma carteira via `GET /wallets/:walletId` retornando seus identificadores, moeda, saldo materializado, versão e timestamps em ISO-8601.

#### Scenario: Consulta de carteira existente
- **WHEN** um cliente envia `GET /wallets/:walletId` para uma carteira existente com `walletId` em formato UUID válido
- **THEN** o sistema responde `200 OK` com `{ id, playerId, currency, balance: { amount, currency }, version, createdAt, updatedAt }`

#### Scenario: Consulta de carteira inexistente
- **WHEN** um cliente envia `GET /wallets/:walletId` com UUID válido que não corresponde a nenhuma carteira cadastrada
- **THEN** o sistema responde `404 Not Found`

#### Scenario: Consulta com identificador de carteira malformado
- **WHEN** um cliente envia `GET /wallets/:walletId` com `walletId` fora do formato UUID
- **THEN** o sistema responde `400 Bad Request`

### Requirement: Mutações de saldo, versionamento e proteção contra saldo negativo
O sistema SHALL processar débitos e créditos apenas com valores estritamente positivos na mesma moeda da carteira, incrementando `version` em `+1` somente quando o saldo muda e impedindo saldo negativo tanto na aplicação quanto no banco de dados.

#### Scenario: Aplicação de crédito válido na carteira
- **WHEN** um crédito com valor estritamente positivo e mesma moeda da carteira é aplicado dentro de uma transação atômica
- **THEN** o saldo aumenta exatamente pelo valor creditado, `version` incrementa em `+1`, `updatedAt` é atualizado, um lançamento `CREDIT` é gravado no ledger e o evento `WalletBalanceChanged` é enfileirado em `outbox_messages` na mesma transação (nunca publicado antes do commit)

#### Scenario: Aplicação de débito válido na carteira
- **WHEN** um débito com valor estritamente positivo, mesma moeda e menor ou igual ao saldo corrente é aplicado dentro de uma transação atômica
- **THEN** o saldo diminui exatamente pelo valor debitado, `version` incrementa em `+1`, `updatedAt` é atualizado, um lançamento `DEBIT` é gravado no ledger e o evento `WalletBalanceChanged` é enfileirado em `outbox_messages` na mesma transação

#### Scenario: Rejeição de débito por saldo insuficiente
- **WHEN** ocorre tentativa de débito com valor superior ao saldo disponível na carteira
- **THEN** a operação é rejeitada por saldo insuficiente
- **AND** o saldo materializado e `version` permanecem inalterados

#### Scenario: Rejeição de movimentação com valor zero ou negativo
- **WHEN** ocorre tentativa de crédito ou débito na carteira com valor igual a `"0.00"` ou negativo
- **THEN** a operação é rejeitada sem alterar o saldo nem `version`

#### Scenario: Proteção de integridade de saldo e versão no banco de dados
- **WHEN** ocorre tentativa de inserir ou atualizar em `wallets` um registro com `balance_amount < 0` ou `version < 1`
- **THEN** o PostgreSQL rejeita a operação por violação das constraints `chk_wallets_balance_non_negative` e `chk_wallets_version_positive`

### Requirement: Serialização de concorrência por carteira
O sistema SHALL usar `walletId` como unidade de concorrência, serializando mutações simultâneas sobre a mesma carteira sem aplicar lock global entre carteiras distintas e mantendo correção entre múltiplas instâncias.

#### Scenario: Disputa simultânea de saldo na mesma carteira
- **WHEN** uma carteira possui saldo de `"100.00"` e duas operações de débito de `"80.00"` competem simultaneamente pela mesma `walletId`
- **THEN** as operações são serializadas por lock exclusivo no registro da carteira
- **AND** exatamente uma operação é efetivada e a outra é rejeitada por saldo insuficiente
- **AND** o saldo final materializado resulta em `"20.00"`, nunca fica negativo e corresponde exatamente ao saldo calculado no ledger

#### Scenario: Execução paralela em carteiras distintas
- **WHEN** operações simultâneas atingem carteiras diferentes (`walletId` distintos)
- **THEN** cada transação adquire lock apenas sobre sua respectiva carteira, sem bloqueio global entre carteiras

### Requirement: Imutabilidade e integridade contábil do ledger
O sistema SHALL manter `wallet_ledger_entries` como registro estritamente imutável (*append-only*), com equação aritmética consistente e no máximo um lançamento por `(walletId, transactionId)`.

#### Scenario: Registro de lançamento contábil consistente
- **WHEN** um lançamento é criado e persistido em `wallet_ledger_entries`
- **THEN** o lançamento possui `direction` em `DEBIT` ou `CREDIT` (`chk_ledger_direction`), `amount > 0` (`chk_ledger_amount_positive`), `balance_before >= 0` e `balance_after >= 0` (`chk_ledger_balances_non_negative`), satisfaz exatamente `balance_before + amount = balance_after` para `CREDIT` ou `balance_before - amount = balance_after` para `DEBIT` (`chk_ledger_balanced`) e é único por `(wallet_id, transaction_id)` (`uq_ledger_wallet_transaction`), com exclusão bloqueada por `ON DELETE RESTRICT` nas chaves estrangeiras

#### Scenario: Bloqueio físico de atualização ou exclusão no ledger
- **WHEN** ocorre qualquer tentativa de `UPDATE` ou `DELETE` sobre `wallet_ledger_entries` no PostgreSQL
- **THEN** o trigger `trg_prevent_ledger_mutation` aborta a operação mantendo todos os lançamentos originais intactos

#### Scenario: Rejeição de equação contábil inválida no banco de dados
- **WHEN** ocorre tentativa de inserir em `wallet_ledger_entries` um lançamento em que `balance_after` diverge de `balance_before ± amount`
- **THEN** o PostgreSQL rejeita a inserção por violação da constraint `chk_ledger_balanced`

### Requirement: Consulta paginada do extrato do ledger
O sistema SHALL expor o histórico imutável de lançamentos de uma carteira via `GET /wallets/:walletId/ledger` com paginação por cursor opaco ordenada por `createdAt DESC, id DESC`.

#### Scenario: Consulta da primeira página do extrato com limite padrão ou informado
- **WHEN** um cliente envia `GET /wallets/:walletId/ledger` para carteira existente sem `limit` ou com `limit` inteiro entre `1` e `100` (default `50`)
- **THEN** o sistema responde `200 OK` com `{ entries, nextCursor? }` ordenado por `createdAt DESC, id DESC`
- **AND** `nextCursor` é retornado apenas quando existem lançamentos adicionais além da página atual

#### Scenario: Paginação subsequente usando cursor opaco válido
- **WHEN** um cliente envia `GET /wallets/:walletId/ledger` passando o `nextCursor` retornado pela página anterior
- **THEN** o sistema retorna apenas os lançamentos estritamente anteriores na ordenação `(createdAt DESC, id DESC)`, sem repetições nem omissões

#### Scenario: Validação de carteira inexistente ou parâmetros de consulta inválidos
- **WHEN** um cliente envia `GET /wallets/:walletId/ledger` para carteira inexistente ou com `walletId` não-UUID, `limit` menor que `1`, `limit` maior que `100`, `limit` não-inteiro ou parâmetros extras não permitidos
- **THEN** o sistema responde `404 Not Found` quando a carteira não existe (com UUID válido) ou `400 Bad Request` para falhas de validação de entrada

#### Scenario: Cursor com Base64 ou JSON malformado ignorado na consulta
- **WHEN** um cliente envia `GET /wallets/:walletId/ledger` com `cursor` em formato Base64 ou JSON que falha ao ser decodificado/interpretado
- **THEN** o sistema ignora silenciosamente o filtro de cursor e responde `200 OK` retornando a primeira página do extrato (ressalva registrada para futura rejeição com `400 Bad Request`)

#### Scenario: Cursor decodificável com campos incompatíveis com o banco
- **WHEN** um cliente envia `GET /wallets/:walletId/ledger` com `cursor` em Base64 de JSON decodificável contendo `createdAt` ou `id` incompatíveis com os tipos esperados na consulta SQL
- **THEN** a consulta falha retornando `500 Internal Server Error` (ressalva registrada para futura validação de schema do cursor com `400 Bad Request`)

### Requirement: Reconciliação contábil de carteira
O sistema SHALL expor `POST /wallets/:walletId/reconciliation` para comparar o saldo materializado em `wallets` com o saldo recalculado a partir de `wallet_ledger_entries` (`SUM(CREDIT) - SUM(DEBIT)`), sinalizando divergências sem corrigi-las silenciosamente.

#### Scenario: Reconciliação de carteira consistente
- **WHEN** um cliente envia `POST /wallets/:walletId/reconciliation` para uma carteira cujo saldo armazenado é igual a `SUM(CREDIT) - SUM(DEBIT)` (incluindo carteira com saldo `"0.00"` e `checkedEntries = 0`)
- **THEN** o sistema responde `200 OK` com `{ walletId, storedBalance, calculatedBalance, difference: { amount: "0.00", currency }, consistent: true, checkedEntries }`

#### Scenario: Detecção de divergência contábil sem autocorreção
- **WHEN** o saldo materializado difere do saldo recalculado pelos lançamentos do ledger
- **THEN** o sistema responde `200 OK` com `consistent: false` e `difference = storedBalance - calculatedBalance`
- **AND** preserva o saldo materializado sem correção silenciosa e registra log estruturado com `event = "WALLET_RECONCILIATION_DIVERGENCE"` (sem contabilização atual em métrica dedicada; ressalva registrada)

#### Scenario: Leituras independentes fora de snapshot transacional comum
- **WHEN** `POST /wallets/:walletId/reconciliation` é executado concorrentemente a movimentações na mesma carteira
- **THEN** a leitura do saldo da carteira e a agregação do ledger ocorrem em duas consultas independentes sem transação ou snapshot compartilhado (ressalva registrada para futura execução sob snapshot consistente)

#### Scenario: Reconciliação de carteira inexistente ou identificador inválido
- **WHEN** um cliente envia `POST /wallets/:walletId/reconciliation` com `walletId` fora do formato UUID ou para carteira inexistente
- **THEN** o sistema responde `400 Bad Request` para UUID inválido ou `404 Not Found` para carteira inexistente
