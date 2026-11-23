# wagering-transactions Specification

## Purpose

Especificar o comportamento observável, os contratos HTTP e de mensageria SQS FIFO, a máquina de estados, as regras por tipo de transação, a idempotência persistente, a serialização por carteira, o tratamento de referências fora de ordem e as garantias no PostgreSQL da capacidade `wagering-transactions`, retratando fielmente a implementação atual.

## Requirements

### Requirement: Submissão HTTP e validação de contrato de transações de apostas
O sistema SHALL expor `POST /wagering/transactions` exigindo o header `Idempotency-Key` e payload válido de transação externa (proibindo `kind = "OPENING"` e propriedades extras), retornando status HTTP determinístico conforme o estado resultante da transação.

#### Scenario: Rejeição por ausência ou vazio do header Idempotency-Key
- **WHEN** um cliente envia `POST /wagering/transactions` sem o header `Idempotency-Key` ou com valor composto apenas por espaços em branco
- **THEN** o sistema responde `400 Bad Request` no envelope padrão `{ statusCode, error, message, failureCode, path, correlationId, timestamp }` sem processar nem persistir a transação

#### Scenario: Rejeição por payload inválido ou tentativa externa de OPENING
- **WHEN** um cliente envia `POST /wagering/transactions` com `providerId`, `externalTransactionId`, `roundId` ou `gameId` vazio/não-string, `playerId` ou `walletId` não-UUID, `money` inválido, `kind` fora de `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK` (incluindo `OPENING`), `referenceExternalTransactionId` vazio quando informado ou campos extras não permitidos
- **THEN** o sistema responde `400 Bad Request` sem persistir alterações financeiras ou transacionais

#### Scenario: Propagação do identificador de correlação e mapeamento determinístico de status HTTP
- **WHEN** uma requisição `POST /wagering/transactions` válida é processada com ou sem header `X-Correlation-Id`
- **THEN** o sistema utiliza `X-Correlation-Id` (ou `Idempotency-Key` como fallback) nos eventos e no header de resposta `X-Correlation-Id`
- **AND** responde `200 OK` para `status = "PROCESSED"`, `202 Accepted` para `status = "PENDING_REFERENCE"`, `422 Unprocessable Entity` para `status = "REJECTED"` e `500 Internal Server Error` para `status = "FAILED"`, com corpo `{ transactionId, status, balance: { amount, currency }, idempotentReplay, failureCode? }` (preservando o status HTTP correspondente em replays)

#### Scenario: Submissão de REFUND ou ROLLBACK sem referência externa ou com valor zero em operação financeira
- **WHEN** um cliente envia `POST /wagering/transactions` com `kind` igual a `REFUND` ou `ROLLBACK` omitindo `referenceExternalTransactionId`, ou envia `kind` em `BET`, `WIN`, `REFUND` ou `ROLLBACK` com `money.amount = "0.00"`
- **THEN** a validação de entrada aceita a requisição e a operação falha internamente durante a execução retornando `500 Internal Server Error` sem alterar saldo nem ledger (ressalva registrada para futura rejeição determinística com `400 Bad Request` ou `422 Unprocessable Entity`)

### Requirement: Elegibilidade da carteira e serialização por walletId
O sistema SHALL usar `walletId` como unidade de concorrência em múltiplas instâncias, serializando transações simultâneas sobre a mesma carteira sem lock global entre carteiras distintas e validando existência, titularidade do jogador e compatibilidade de moeda da carteira antes da movimentação.

#### Scenario: Disputa simultânea de saldo na mesma carteira
- **WHEN** duas transações `BET` de `"80.00"` competem simultaneamente por uma carteira com saldo de `"100.00"`
- **THEN** o sistema serializa a execução por lock exclusivo no registro da carteira (`walletId`)
- **AND** exatamente uma aposta termina `PROCESSED` (`200 OK`) e a outra termina `REJECTED` com `failureCode = "INSUFFICIENT_FUNDS"` (`422 Unprocessable Entity`)
- **AND** o saldo final resulta em `"20.00"` em consistência exata com o ledger

#### Scenario: Execução paralela entre carteiras distintas
- **WHEN** transações simultâneas atingem `walletId` diferentes
- **THEN** cada transação adquire lock exclusivo apenas sobre sua respectiva carteira, sem contenção global entre carteiras

#### Scenario: Rejeição de transação para carteira inexistente, titular divergente ou moeda incompatível
- **WHEN** uma submissão informa `walletId` não cadastrada, `playerId` diferente do titular da carteira ou `money.currency` diferente da moeda da carteira
- **THEN** o sistema responde `404 Not Found` para carteira inexistente ou `422 Unprocessable Entity` para titular ou moeda divergentes
- **AND** não altera saldo, não grava lançamento no ledger e não persiste registro `REJECTED` nem evento de rejeição (ressalva registrada para futura emissão de `failureCode` e auditoria persistida)

### Requirement: Idempotência persistente e integridade canônica de payload
O sistema SHALL garantir idempotência persistente no PostgreSQL por `idempotency_key` e por `(provider_id, external_transaction_id)` validada via hash SHA-256 do JSON canônico de negócio, distinguindo replays idênticos de conflitos de payload e resolvendo colisões concorrentes.

#### Scenario: Replay idêntico sequencial ou sob alta concorrência
- **WHEN** uma mesma transação (mesma `Idempotency-Key` ou mesmo par `(providerId, externalTransactionId)` e mesmo payload canônico de negócio, mesmo com ordem distinta de chaves JSON) é submetida repetidamente em sequência ou por 50 requisições simultâneas
- **THEN** exatamente uma execução é aplicada com `idempotentReplay = false` e todas as demais retornam o mesmo `transactionId`, o mesmo `status` (e eventual `failureCode`), o saldo atual da carteira e `idempotentReplay = true`
- **AND** não ocorre novo débito, crédito, lançamento no ledger nem enfileiramento duplicado na outbox, contabilizando a duplicata detectada em métrica operacional

#### Scenario: Conflito de idempotência por divergência de payload
- **WHEN** uma requisição reutiliza `Idempotency-Key` ou `(providerId, externalTransactionId)` já persistidos anteriormente para a mesma carteira, porém alterando qualquer dado de negócio do hash canônico (`roundId`, `gameId`, `kind`, `money.amount`, `referenceExternalTransactionId`, etc.)
- **THEN** o sistema rejeita a requisição com `409 Conflict` contendo `failureCode = "IDEMPOTENCY_PAYLOAD_MISMATCH"` sem alterar saldo nem ledger

#### Scenario: Divergência de carteira, titular ou moeda durante replay idempotente
- **WHEN** uma requisição reutiliza uma `Idempotency-Key` já existente alterando `walletId` para inexistente, `playerId` para divergente da carteira ou `money.currency` para divergente da carteira
- **THEN** a verificação prévia de elegibilidade da carteira prevalece sobre a checagem de idempotência e responde `404 Not Found` ou `422 Unprocessable Entity` em vez de `409 Conflict` (ressalva registrada para futura inversão da ordem de validação)

### Requirement: Processamento de transações BET, WIN e LOSS
O sistema SHALL processar operações `BET`, `WIN` e `LOSS` dentro de transação atômica aplicando as respectivas mutações de saldo, lançamentos imutáveis no ledger e eventos de integração na tabela `outbox_messages`.

#### Scenario: Aposta BET aprovada com saldo suficiente
- **WHEN** uma transação `BET` com valor estritamente positivo e menor ou igual ao saldo disponível é processada
- **THEN** o saldo da carteira é debitado pelo valor da aposta, `version` incrementa em `+1`, a transação é salva com `status = "PROCESSED"`, um lançamento `DEBIT` é gravado em `wallet_ledger_entries` e dois eventos (`WalletBalanceChanged` v1 e `WagerTransactionProcessed` v1) são gravados em `outbox_messages` na mesma transação SQL

#### Scenario: Aposta BET rejeitada por saldo insuficiente
- **WHEN** uma transação `BET` solicita valor superior ao saldo disponível na carteira
- **THEN** a transação é persistida com `status = "REJECTED"` e `failureCode = "INSUFFICIENT_FUNDS"`, o evento `WagerTransactionRejected` v1 é gravado em `outbox_messages`, saldo e `version` permanecem intactos sem lançamento no ledger e a API responde `422 Unprocessable Entity`

#### Scenario: Premiação WIN aplicada à carteira
- **WHEN** uma transação `WIN` com valor estritamente positivo é processada
- **THEN** o saldo da carteira é creditado pelo valor do prêmio, `version` incrementa em `+1`, a transação é salva com `status = "PROCESSED"`, um lançamento `CREDIT` é gravado em `wallet_ledger_entries` e `WalletBalanceChanged` v1 e `WagerTransactionProcessed` v1 são gravados em `outbox_messages`

#### Scenario: Registro informativo de LOSS sem movimentação financeira
- **WHEN** uma transação `LOSS` (com valor zero `"0.00"` ou positivo) é processada
- **THEN** a transação é salva com `status = "PROCESSED"` e apenas `WagerTransactionProcessed` v1 é gravado em `outbox_messages`
- **AND** o saldo e `version` da carteira permanecem inalterados e nenhum lançamento é gravado em `wallet_ledger_entries`

### Requirement: Processamento de estornos REFUND
O sistema SHALL processar transações `REFUND` exclusivamente sobre uma transação `BET` já existente e `PROCESSED` do mesmo `providerId`, `roundId` e `money`, creditando o valor estornado na carteira e vinculando `referenceTransactionId`.

#### Scenario: Estorno REFUND válido sobre BET processada
- **WHEN** uma transação `REFUND` referencia via `(providerId, referenceExternalTransactionId)` uma transação `BET` com `status = "PROCESSED"`, mesmo `roundId` e exatamente o mesmo `money`
- **THEN** a carteira é creditada no valor estornado, `version` incrementa em `+1`, a transação é salva com `status = "PROCESSED"` e `referenceTransactionId` apontando para a `BET` original, um lançamento `CREDIT` é gravado no ledger e `WalletBalanceChanged` v1 e `WagerTransactionProcessed` v1 são gravados em `outbox_messages`

#### Scenario: Rejeição de REFUND por tipo, estado, rodada ou valor incompatível da referência
- **WHEN** uma transação `REFUND` encontra uma referência que não é `BET`, não está em `PROCESSED`, possui `roundId` divergente ou possui `money` divergente
- **THEN** o sistema persiste a transação com `status = "REJECTED"` e o respectivo `failureCode` (`INVALID_REFERENCE_TRANSACTION`, `INVALID_TRANSACTION_STATE`, `ROUND_MISMATCH` ou `AMOUNT_MISMATCH`), enfileira `WagerTransactionRejected` v1, mantém saldo e ledger intactos e responde `422 Unprocessable Entity`

#### Scenario: Tentativa de segundo REFUND ou divergência de titularidade da referência
- **WHEN** um segundo `REFUND` distinto tenta estornar uma `BET` já estornada por outro `REFUND` processado, ou um `REFUND` referencia uma `BET` pertencente a outro `playerId` ou `walletId`
- **THEN** o segundo `REFUND` distinto falha por violação do índice único parcial `uq_wager_tx_single_reversal` retornando `500 Internal Server Error` (em vez de `REJECTED` com `TRANSACTION_ALREADY_REVERSED`), e a divergência de `playerId`/`walletId` entre transação e referência não é bloqueada (ressalvas registradas para endurecimento futuro)

### Requirement: Processamento de reversões ROLLBACK
O sistema SHALL processar transações `ROLLBACK` sobre transações `BET`, `WIN` ou `REFUND` já `PROCESSED` do mesmo `providerId`, `roundId` e `money`, invertendo o sentido contábil original e impedindo saldo negativo em reversões de crédito.

#### Scenario: ROLLBACK válido sobre BET, WIN ou REFUND processado
- **WHEN** uma transação `ROLLBACK` referencia via `(providerId, referenceExternalTransactionId)` uma transação `BET`, `WIN` ou `REFUND` em `status = "PROCESSED"` com mesmo `roundId` e mesmo `money`
- **THEN** o sistema aplica `CREDIT` na carteira se a referência for `BET`, ou `DEBIT` na carteira (quando houver saldo suficiente) se a referência for `WIN` ou `REFUND`, incrementa `version` em `+1`, vincula `referenceTransactionId`, grava o lançamento correspondente no ledger e enfileira `WalletBalanceChanged` v1 e `WagerTransactionProcessed` v1

#### Scenario: Rejeição de ROLLBACK por saldo insuficiente para reversão de crédito
- **WHEN** um `ROLLBACK` sobre `WIN` ou `REFUND` exige débito superior ao saldo corrente da carteira
- **THEN** a transação é persistida com `status = "REJECTED"` e `failureCode = "INSUFFICIENT_FUNDS_FOR_REVERSAL"`, `WagerTransactionRejected` v1 é gravado em `outbox_messages`, o saldo permanece não negativo e a API responde `422 Unprocessable Entity`

#### Scenario: Rejeição de ROLLBACK por referência incompatível
- **WHEN** um `ROLLBACK` encontra referência de tipo inválido (`LOSS`, `OPENING` ou `ROLLBACK`), estado não-`PROCESSED`, `roundId` divergente ou `money` divergente
- **THEN** a transação é persistida com `status = "REJECTED"` e o respectivo `failureCode` (`INVALID_REFERENCE_TRANSACTION`, `INVALID_TRANSACTION_STATE`, `ROUND_MISMATCH` ou `AMOUNT_MISMATCH`), enfileira `WagerTransactionRejected` v1 e responde `422 Unprocessable Entity`

#### Scenario: Dupla reversão de ROLLBACK ou combinação de REFUND e ROLLBACK na mesma aposta
- **WHEN** um segundo `ROLLBACK` distinto tenta reverter uma referência já revertida por `ROLLBACK`, ou um `ROLLBACK` e um `REFUND` distintos incidem sobre a mesma `BET`
- **THEN** o segundo `ROLLBACK` falha no banco por `uq_wager_tx_single_reversal` retornando `500 Internal Server Error`, enquanto a combinação `REFUND` + `ROLLBACK` sobre a mesma `BET` é aceita pelo índice composto `(reference_transaction_id, kind)` caso haja saldo (ressalvas registradas para futura unicidade global de reversão por referência e rejeição de domínio `TRANSACTION_ALREADY_REVERSED`)

### Requirement: Referências fora de ordem e reprocessamento periódico
O sistema SHALL registrar transações `REFUND` ou `ROLLBACK` recebidas antes da transação referenciada no estado `PENDING_REFERENCE` sem alterar o saldo, rejeitando-as automaticamente quando permanecerem sem referência válida além do TTL de 10 minutos.

#### Scenario: Recepção de estorno ou reversão com referência ainda ausente
- **WHEN** uma transação `REFUND` ou `ROLLBACK` válida chega antes de `referenceExternalTransactionId` existir para o mesmo `providerId`
- **THEN** a transação é persistida com `status = "PENDING_REFERENCE"`, o evento `WagerTransactionPendingReference` v1 é gravado em `outbox_messages`, saldo e ledger permanecem inalterados e a API responde `202 Accepted`

#### Scenario: Expiração automática após 10 minutos sem referência disponível
- **WHEN** o processamento periódico em lote (a cada 5 segundos, até 20 transações ordenadas por `created_at ASC`) avalia uma transação em `PENDING_REFERENCE` com idade superior a 10 minutos cuja referência continua ausente ou não-`PROCESSED`
- **THEN** o sistema transiciona a transação para `REJECTED` com `failureCode = "REFERENCE_NOT_FOUND"` e enfileira `WagerTransactionRejected` v1 em `outbox_messages` na mesma transação atômica

#### Scenario: Tentativa de reprocessamento quando a referência chega como PROCESSED
- **WHEN** a transação referenciada atinge `status = "PROCESSED"` e o job periódico tenta reprocessar a transação pendente invocando novamente o fluxo principal com a mesma `idempotencyKey`
- **THEN** a verificação de idempotência encontra o registro já existente em `PENDING_REFERENCE` com mesmo `payloadHash` e devolve replay sem executar o estorno/reversão, mantendo a transação em `PENDING_REFERENCE` (ressalva crítica registrada para correção em change dedicada)

### Requirement: Imutabilidade de estados terminais e integridade no PostgreSQL
O sistema SHALL impedir transições adicionais após uma transação atingir estado terminal (`PROCESSED`, `REJECTED` ou `FAILED`) e impor unicidade, integridade referencial e domínio de valores diretamente no schema do PostgreSQL.

#### Scenario: Bloqueio de transição após estado terminal no domínio
- **WHEN** ocorre tentativa de aplicar nova transição de estado (`PENDING_REFERENCE`, `PROCESSED`, `REJECTED` ou `FAILED`) em uma transação já em `PROCESSED`, `REJECTED` ou `FAILED`
- **THEN** a operação é rejeitada no domínio preservando integralmente o estado terminal original

#### Scenario: Imposição de constraints e chaves estrangeiras em wager_transactions, inbox_messages e outbox_messages
- **WHEN** operações de persistência atuam sobre `wager_transactions`, `inbox_messages` e `outbox_messages`
- **THEN** o PostgreSQL garante `pk_wager_transactions`, `fk_wager_tx_wallet` e `fk_wager_tx_reference` com `ON DELETE RESTRICT`, unicidade por `uq_wager_tx_provider_external` e `uq_wager_tx_idempotency_key`, unicidade parcial `uq_wager_tx_single_reversal`, checks `chk_wager_tx_kind`, `chk_wager_tx_status` e `chk_wager_tx_amount_positive` (`amount >= 0`), PK composta `pk_inbox_messages (consumer_name, message_id)` e `pk_outbox_messages`/`chk_outbox_attempts (attempts >= 0)`

### Requirement: Consulta de transações por identificador interno e por provedor
O sistema SHALL expor a consulta individual do estado e metadados de uma transação via identificador interno UUID ou chave composta do provedor.

#### Scenario: Consulta por identificador interno UUID
- **WHEN** um cliente envia `GET /wagering/transactions/:transactionId`
- **THEN** o sistema responde `200 OK` com `{ id, providerId, externalTransactionId, idempotencyKey, walletId, playerId, roundId, gameId, kind, money, status, referenceExternalTransactionId?, referenceTransactionId?, failureCode?, createdAt, processedAt? }` (datas ISO-8601, sem expor `payloadHash`) quando existente, `404 Not Found` quando inexistente ou `400 Bad Request` se `transactionId` não for UUID válido

#### Scenario: Consulta por provedor e identificador externo
- **WHEN** um cliente envia `GET /providers/:providerId/wagering/transactions/:externalTransactionId`
- **THEN** o sistema responde `200 OK` com o mesmo contrato de leitura quando a transação existir ou `404 Not Found` quando não existir

### Requirement: Consumo assíncrono via SQS FIFO e Transactional Inbox
O sistema SHALL consumir mensagens de transações da fila SQS FIFO em long polling contínuo com validação de envelope, deduplicação transacional em `inbox_messages` na mesma transação das mutações financeiras e confirmação (ACK) apenas após commit bem-sucedido no PostgreSQL.

#### Scenario: Consumo válido com deduplicação transacional e ACK pós-commit
- **WHEN** uma mensagem válida no formato `{ messageId, type, occurredAt, data }` (com `data.kind` distinto de `OPENING` e `idempotencyKey` opcional usando fallback `${providerId}:${externalTransactionId}`) é recebida da fila SQS FIFO
- **THEN** o sistema grava `(consumer_name = "wager-transactions-consumer", message_id)` derivado do identificador da mensagem SQS (ou `messageId` do envelope como fallback) em `inbox_messages` na mesma transação SQL que persiste a transação, carteira, ledger e outbox
- **AND** executa a remoção da mensagem no SQS somente após o commit com sucesso (tanto para resultados `PROCESSED`, `REJECTED` e `PENDING_REFERENCE` quanto para replays)

#### Scenario: Mensagem malformada ou erro de processamento sem ACK até DLQ
- **WHEN** o corpo da mensagem SQS não é JSON válido, falha na validação do envelope de entrada da fila ou o processamento lança erro (falha de banco/rede ou exceção `404`/`409`/`422` de elegibilidade/conflito)
- **THEN** o sistema não remove a mensagem da fila SQS (contabilizando retry de consumidor apenas para exceções após o parsing) e permite reentrega após `VisibilityTimeout = 30s` até o encaminhamento automático à DLQ FIFO configurado com `maxReceiveCount = 3` (ressalvas registradas quanto à validação permissiva de campos extras/`type` e ao reprocessamento repetido de exceções definitivas)

#### Scenario: Comportamento atual de deduplicação no Inbox e replay prévio
- **WHEN** uma mensagem já registrada em `inbox_messages` é recebida sem registro correspondente em `wager_transactions`, ou uma mensagem cuja transação já foi persistida anteriormente via HTTP chega pela fila pela primeira vez
- **THEN** no primeiro caso o consumidor retorna `idempotentReplay = true` com `transactionId` sintético e `status = "PROCESSED"` antes de qualquer mutação, e no segundo caso o replay em `wager_transactions` retorna antes de gravar `inbox_messages` recebendo ACK (ressalvas registradas para futura unificação do histórico Inbox/Idempotência)

### Requirement: Publicação assíncrona de eventos via Transactional Outbox
O sistema SHALL persistir eventos de integração v1 em `outbox_messages` na mesma transação SQL das operações de apostas (nunca publicando antes do commit) e despachá-los periodicamente para o SQS FIFO com ordenação por agregado e backoff exponencial em falhas.

#### Scenario: Enfileiramento atômico e despacho bem-sucedido com ordenação FIFO
- **WHEN** eventos `WalletBalanceChanged`, `WagerTransactionProcessed`, `WagerTransactionRejected` ou `WagerTransactionPendingReference` (versão `1`) são gravados em `outbox_messages` após o commit da transação
- **THEN** o job periódico (intervalo de `1000ms`, lotes de até `50` pendentes ordenados por `occurred_at ASC`) publica o payload JSON no SQS FIFO usando `MessageGroupId = aggregateId` e `MessageDeduplicationId = outbox.id` e marca `published_at` com `last_error = NULL`

#### Scenario: Reagendamento com backoff exponencial em falha de publicação no broker
- **WHEN** ocorre falha ao enviar uma mensagem da outbox para o SQS
- **THEN** o sistema incrementa `attempts`, registra `last_error`, contabiliza retry de outbox e agenda `next_attempt_at` com backoff exponencial `min(60, 2^attempts)` segundos sem teto máximo de tentativas

#### Scenario: Ressalvas operacionais vigentes na publicação da Outbox
- **WHEN** o worker da outbox consulta mensagens pendentes e despacha eventos na configuração padrão vigente
- **THEN** a consulta com `FOR UPDATE SKIP LOCKED` é executada fora de transação SQL explícita (autocommit) e o envio utiliza a mesma URL de fila `SQS_WAGER_TRANSACTIONS_QUEUE_URL` lida pelo consumidor de entrada de apostas, fazendo eventos de saída falharem na validação de entrada até a DLQ (ressalvas críticas registradas para separação de filas/tópicos e encapsulamento em transação SQL em change dedicada)
