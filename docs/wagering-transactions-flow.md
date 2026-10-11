# Fluxo de Dados e Ciclo de Vida: Endpoint `POST /wagering/transactions`

Este documento detalha o fluxo completo de dados, concorrência, persistência e mensageria distribuída do endpoint **`POST /wagering/transactions`** no sistema **Distributed Wagering Processor**. 

O design do sistema adota os padrões **Transactional Outbox**, **Transactional Inbox**, **Lock Pessimista (Pessimistic Locking)** e **Consistência Contábil Imutável (Double-Entry Ledger)** sobre **PostgreSQL** e **AWS SQS FIFO**.

---

## 1. Visão Geral das Etapas

O ciclo de vida da transação compreende 4 fases principais:

1. **Recepção HTTP e Execução Atômica no Banco (Síncrono)**:
   - Validação da requisição e cálculo do hash canônico SHA-256 do payload.
   - Abertura de transação SQL única gerenciada por `UnitOfWork`.
   - Lock pessimista na carteira (`SELECT ... FOR UPDATE` em `wallets`).
   - Deduplicação e verificação de idempotência em `wager_transactions`.
   - Execução das regras financeiras específicas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`).
   - Persistência atômica nas tabelas: `wallets`, `wager_transactions`, `wallet_ledger_entries` e `outbox_messages`.
   - Commit e retorno da resposta HTTP ao chamador (`200 OK`, `202 Accepted`, `422 Unprocessable` ou `409 Conflict`).

2. **Publicação Confiável na Fila SQS (Assíncrono — Outbox Publisher)**:
   - Polling contínuo (`OutboxPublisherJob`) buscando mensagens pendentes na tabela `outbox_messages` com `SKIP LOCKED`.
   - Envio para a fila **AWS SQS FIFO** com agrupamento estrito (`MessageGroupId = aggregateId`) e deduplicação (`MessageDeduplicationId = outbox.id`).
   - Atualização do registro na tabela `outbox_messages` com `published_at = NOW()`.

3. **Consumo de Eventos da Fila e Deduplicação no Banco (Assíncrono — SQS Consumer)**:
   - Long polling contínuo da fila SQS via `SqsConsumerService`.
   - Validação de schema do payload JSON recebido (`class-validator`).
   - Deduplicação transacional idempotente via tabela `inbox_messages` (Transactional Inbox).
   - Reexecução do caso de uso de domínio e commit atômico no banco.
   - Reconhecimento da mensagem no broker SQS (`DeleteMessageCommand` - ACK) apenas após a confirmação no PostgreSQL.

4. **Resolução de Dependências Fora de Ordem (Pending References Job)**:
   - Caso um estorno (`REFUND`/`ROLLBACK`) chegue antes da aposta original, ele é gravado como `PENDING_REFERENCE`.
   - Um job de background (`PendingReferencesJob`) reprocessa a operação assim que a aposta de referência for comitada.

---

## 2. Diagrama de Sequência Resumido (Fluxo dos Dados)

Este diagrama resume o trânsito dos dados entre a **Aplicação**, o **PostgreSQL** e o broker **AWS SQS**:

```mermaid
sequenceDiagram
    autonumber
    actor Client as Provedor (HTTP Client)
    participant App as Aplicação (API & Use Case)
    participant DB as PostgreSQL (BD)
    participant OutboxJob as Outbox Publisher Job
    participant SQS as AWS SQS FIFO (Fila)
    participant Consumer as SQS Consumer (Worker)

    %% ------------------------------------------------------------------------
    %% 1. ENTRADA HTTP E PERSISTÊNCIA NO BANCO
    %% ------------------------------------------------------------------------
    rect rgb(240, 248, 255)
    note over Client, DB: 1. Entrada HTTP e Gravação no PostgreSQL (Transação Atômica)
    Client->>App: POST /wagering/transactions<br/>Headers: Idempotency-Key<br/>Body: { providerId, externalTxId, playerId, walletId, kind, money }
    
    activate App
    App->>DB: BEGIN TRANSACTION
    App->>DB: SELECT * FROM wallets WHERE id = :walletId FOR UPDATE (Lock Pessimista)
    App->>DB: SELECT * FROM wager_transactions (Checagem de Idempotência)

    note over App, DB: Se transação inédita e válida, persiste atomicamente:
    App->>DB: 1. INSERT INTO wager_transactions (status='PROCESSED', ...)
    App->>DB: 2. UPDATE wallets SET balance = novo_saldo, version = version + 1
    App->>DB: 3. INSERT INTO wallet_ledger_entries (extrato imutável com balance_before/after)
    App->>DB: 4. INSERT INTO outbox_messages (evento enfileirado com published_at = NULL)
    
    App->>DB: COMMIT TRANSACTION
    App-->>Client: HTTP 200 OK { transactionId, status: "PROCESSED", balance }
    deactivate App
    end

    %% ------------------------------------------------------------------------
    %% 2. PUBLICAÇÃO NA FILA SQS (OUTBOX PATTERN)
    %% ------------------------------------------------------------------------
    rect rgb(255, 250, 240)
    note over OutboxJob, SQS: 2. Publicação Assíncrona no SQS (Transactional Outbox)
    OutboxJob->>DB: SELECT * FROM outbox_messages<br/>WHERE published_at IS NULL FOR UPDATE SKIP LOCKED
    DB-->>OutboxJob: Retorna lote de mensagens pendentes

    OutboxJob->>SQS: SendMessage (Body: JSON payload, GroupId: walletId, DedupId: outboxId)
    SQS-->>OutboxJob: Confirmação de recebimento (MessageId)

    OutboxJob->>DB: UPDATE outbox_messages SET published_at = NOW() WHERE id = :outboxId
    end

    %% ------------------------------------------------------------------------
    %% 3. CONSUMO DO SQS E DEDUPLICAÇÃO NO BANCO
    %% ------------------------------------------------------------------------
    rect rgb(245, 255, 250)
    note over SQS, Consumer: 3. Consumo da Fila e Deduplicação no BD (Transactional Inbox)
    Consumer->>SQS: ReceiveMessage (Long Polling)
    SQS-->>Consumer: Mensagem { MessageId, Body: JSON }

    activate Consumer
    Consumer->>App: Processa mensagem
    activate App
    App->>DB: BEGIN TRANSACTION & SELECT 1 FROM inbox_messages (Deduplicação)
    alt Se não processada anteriormente
        App->>DB: INSERT INTO inbox_messages (consumer_name, message_id)
        App->>DB: Executa mutações financeiras (wallets, transactions, ledger, outbox)
    end
    App->>DB: COMMIT TRANSACTION
    deactivate App

    Consumer->>SQS: DeleteMessage (ACK - Remove mensagem da fila)
    deactivate Consumer
    end
```

---

## 3. Diagrama de Atividades (Activity / Decision Flowchart)

O fluxograma abaixo detalha as ramificações de decisão tomadas a cada estágio do processamento:

```mermaid
flowchart TD
    Start([Início: Requisição POST /wagering/transactions]) --> ValHeader{Idempotency-Key<br/>presente?}
    ValHeader -- Não --> Err400[HTTP 400 Bad Request]
    ValHeader -- Sim --> Hash[Calcula Hash Canônico SHA-256 do Payload]

    Hash --> TxBegin[Abre Transação Atômica no PostgreSQL via UnitOfWork]
    TxBegin --> LockWallet[SELECT * FROM wallets WHERE id = :walletId FOR UPDATE]

    LockWallet --> WalletExists{Carteira<br/>existe e<br/>válida?}
    WalletExists -- Não / Moeda Incompatível --> RollbackErr[Rollback & Retorna 404 ou 422]
    WalletExists -- Sim --> CheckTx[Verifica Idempotência em wager_transactions]

    CheckTx --> ExistsTx{Transação já<br/>cadastrada?}
    ExistsTx -- Sim --> CheckHash{Hash do payload<br/>é idêntico?}
    CheckHash -- Não --> Err409[Rollback & Retorna 409 Conflict: IdempotencyPayloadMismatch]
    CheckHash -- Sim --> ReturnReplay[Commit & Retorna 200 OK: Replay Idempotente]

    ExistsTx -- Não --> CheckOrigin{Origem é<br/>Mensageria SQS?}
    CheckOrigin -- Sim --> CheckInbox{Mensagem já existe<br/>em inbox_messages?}
    CheckInbox -- Sim --> ReturnReplay
    CheckInbox -- Não --> InsertInbox[Grava em inbox_messages como PROCESSED]
    CheckInbox -- Não --> EvalKind

    CheckOrigin -- Não --> EvalKind[Avalia o Tipo da Transação - Kind]

    %% Tipos de Transação
    EvalKind -->|BET| KindBet{Saldo na Carteira<br/>>= Valor da Aposta?}
    KindBet -- Não --> RejectBet[tx.reject: INSUFFICIENT_FUNDS]
    RejectBet --> SaveRejTx[Salva wager_transactions como REJECTED]
    SaveRejTx --> OutboxRej[Salva em outbox_messages: WagerTransactionRejected]
    OutboxRej --> CommitRej[Commit & Retorna HTTP 422]

    KindBet -- Sim --> DebitWallet[wallet.debit: Subtrai valor do Saldo]
    DebitWallet --> SaveBetTx[Salva wager_transactions como PROCESSED]
    SaveBetTx --> SaveBetLedger[Salva wallet_ledger_entries: DEBIT com balance_before e balance_after]
    SaveBetLedger --> OutboxSuccess[Salva em outbox_messages:<br/>1. WalletBalanceChanged<br/>2. WagerTransactionProcessed]
    OutboxSuccess --> CommitSuccess[Commit & Retorna HTTP 200 OK]

    EvalKind -->|WIN| CreditWallet[wallet.credit: Adiciona valor ao Saldo]
    CreditWallet --> SaveWinTx[Salva wager_transactions como PROCESSED]
    SaveWinTx --> SaveWinLedger[Salva wallet_ledger_entries: CREDIT]
    SaveWinLedger --> OutboxSuccess

    EvalKind -->|LOSS| SaveLossTx[Salva wager_transactions como PROCESSED<br/>Saldo inalterado e sem Ledger]
    SaveLossTx --> OutboxLoss[Salva em outbox_messages: WagerTransactionProcessed]
    OutboxLoss --> CommitSuccess

    EvalKind -->|REFUND ou ROLLBACK| FindRef[Busca transação de referência por providerId e refExternalId]
    FindRef --> RefFound{Referência<br/>encontrada no BD?}

    RefFound -- Não --> MarkPending[tx.markPendingReference]
    MarkPending --> SavePendingTx[Salva wager_transactions como PENDING_REFERENCE]
    SavePendingTx --> OutboxPending[Salva em outbox_messages: WagerTransactionPendingReference]
    OutboxPending --> CommitPending[Commit & Retorna HTTP 202 Accepted]

    RefFound -- Sim --> ValRef{Referência é válida<br/>e compatível com round/valor?}
    ValRef -- Não --> RejectRef[Salva wager_transactions como REJECTED e Outbox WagerTransactionRejected]
    RejectRef --> CommitRej

    ValRef -- Sim --> ExecRef[Aplica reversão de saldo na carteira e grava Ledger reverso]
    ExecRef --> SaveRefTx[Salva wager_transactions como PROCESSED associando reference_transaction_id]
    SaveRefTx --> OutboxSuccess

    %% Ciclo Assíncrono Outbox
    CommitSuccess & CommitRej & CommitPending --> OutboxPoll[OutboxPublisherJob Polling a cada 1s]
    OutboxPoll --> FetchOutbox[SELECT * FROM outbox_messages WHERE published_at IS NULL FOR UPDATE SKIP LOCKED]
    FetchOutbox --> SendSQS[Envia mensagem para AWS SQS FIFO com MessageGroupId e MessageDeduplicationId]
    SendSQS --> MarkPublished[UPDATE outbox_messages SET published_at = NOW]

    %% Ciclo Assíncrono Consumer
    MarkPublished -. Mensagem disponível no Broker .-> SQSConsume[SqsConsumerService Long Polling]
    SQSConsume --> ValidateDto[Valida Payload JSON via class-validator]
    ValidateDto --> RunUseCase[Chama ProcessWagerTransactionUseCase com consumerMessageId]
    RunUseCase --> AckSQS[DeleteMessageCommand no SQS: ACK]
```

---

## 4. Mapeamento do Fluxo de Dados e Alterações no Banco de Dados

Abaixo está o detalhamento estruturado de quais dados chegam na requisição HTTP e como cada tabela do PostgreSQL é impactada.

### 4.1. Dados de Entrada da Requisição HTTP

Endpoint: **`POST /wagering/transactions`**

| Campo | Tipo / Origem | Obrigatório | Descrição |
| :--- | :--- | :---: | :--- |
| `Idempotency-Key` | Header HTTP (`string`) | Sim | Chave única enviada pelo provedor para garantir idempotência. |
| `providerId` | Body JSON (`string`) | Sim | Identificador do provedor do jogo (ex: `"pragmatic-play"`). |
| `externalTransactionId`| Body JSON (`string`) | Sim | Identificador único da transação gerado no sistema do provedor. |
| `playerId` | Body JSON (`UUID`) | Sim | Identificador do jogador dono da carteira. |
| `walletId` | Body JSON (`UUID`) | Sim | Identificador único da carteira do jogador. |
| `roundId` | Body JSON (`string`) | Sim | Identificador da rodada de jogo associada. |
| `gameId` | Body JSON (`string`) | Sim | Identificador do jogo no provedor. |
| `kind` | Body JSON (`enum`) | Sim | Tipo de operação: `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`. |
| `money.amount` | Body JSON (`string` / num) | Sim | Valor monetário no formato `NUMERIC(18, 2)` (ex: `"10.50"`). |
| `money.currency` | Body JSON (`string`) | Sim | Moeda ISO-4217 com 3 caracteres (ex: `"BRL"`). |
| `referenceExternalTransactionId` | Body JSON (`string`) | Condicional | Obrigatório para operações `REFUND` e `ROLLBACK`. Identifica a transação anterior a ser estornada. |

---

### 4.2. Alterações Realizadas no Banco de Dados (Transação SQL Atômica)

Todas as operações abaixo ocorrem sob a **mesma transação SQL** controlada pelo `UnitOfWorkPort` (`TypeOrmUnitOfWork`):

#### 1. Tabela `wallets`
* **Bloqueio Concorrente**: Bloqueada no início via `SELECT ... FOR UPDATE` (Pessimistic Write Lock), serializando qualquer operação concorrente para o mesmo `wallet_id`.
* **Alterações no Sucesso (`BET`, `WIN`, `REFUND`, `ROLLBACK`)**:
  - `balance_amount`: Atualizado aritmeticamente (subtraído no `BET`/`ROLLBACK de WIN`, somado no `WIN`/`REFUND`/`ROLLBACK de BET`).
  - `version`: Incrementado em `+1`.
  - `updated_at`: Atualizado com o timestamp corrente.
* **Invariante no Banco**: Constraint `CHECK (balance_amount >= 0)` impede saldo negativo no nível físico do banco.

#### 2. Tabela `wager_transactions`
* **Inserção do Registro da Transação**:
  - `id`: UUID gerado pela aplicação.
  - `provider_id`: Provedor requisitante.
  - `external_transaction_id`: ID externo do provedor.
  - `idempotency_key`: Chave enviada no header.
  - `payload_hash`: SHA-256 do JSON canônico para validação de reenvio idêntico vs reenvio com parâmetros modificados.
  - `wallet_id`, `player_id`, `round_id`, `game_id`, `kind`, `amount`, `currency`: Dados do negócio.
  - `status`:
    - `PROCESSED`: Se executada com sucesso.
    - `REJECTED`: Se rejeitada por violação de regra (ex: saldo insuficiente, rodada inválida).
    - `PENDING_REFERENCE`: Se a transação de referência de um estorno ainda não chegou.
  - `reference_external_transaction_id`: Preenchido em `REFUND`/`ROLLBACK`.
  - `reference_transaction_id`: FK para a transação interna quando resolvida.
  - `failure_code`: Código de erro quando rejeitada (ex: `INSUFFICIENT_FUNDS`, `INVALID_REFERENCE_TRANSACTION`).
  - `created_at` e `processed_at`: Timestamps de auditoria.

#### 3. Tabela `wallet_ledger_entries` (Extrato Contábil Imutável)
* **Inserção (Append-Only)** — Apenas quando há mutação de saldo (`BET`, `WIN`, `REFUND`, `ROLLBACK` com impacto financeiro):
  - `id`: UUID único.
  - `wallet_id`: ID da carteira.
  - `transaction_id`: FK para `wager_transactions.id`.
  - `direction`: `DEBIT` ou `CREDIT`.
  - `amount` e `currency`: Valor e moeda da transação.
  - `balance_before`: Saldo exato da carteira antes da operação.
  - `balance_after`: Saldo exato da carteira após a operação.
  - `created_at`: Data e hora da operação.
* **Invariantes no Banco**:
  - Constraint aritmética: `balance_before ± amount = balance_after`.
  - Trigger de proteção: impede qualquer `UPDATE` ou `DELETE` nesta tabela.

#### 4. Tabela `outbox_messages` (Transactional Outbox)
* **Inserção de Mensagens**:
  - `id`: UUID da mensagem.
  - `aggregate_id`: ID do aggregate (ID da carteira ou da transação), usado posteriormente como `MessageGroupId` no SQS FIFO.
  - `event_type`: Nome do evento de domínio gerado:
    - `WalletBalanceChanged`: Informa alteração do saldo com versão da carteira.
    - `WagerTransactionProcessed`: Informa conclusão da aposta/prêmio/estorno.
    - `WagerTransactionRejected`: Informa rejeição com motivo de falha.
    - `WagerTransactionPendingReference`: Informa espera por dependência fora de ordem.
  - `payload`: JSON completo com dados e metadados (`eventId`, `correlationId`, `occurredAt`, dados de negócio).
  - `attempts`: Inicia em `0`.
  - `published_at`: `NULL` (marca que o evento ainda não foi enviado ao SQS).
  - `next_attempt_at`: Data atual (`NOW()`), tornando-o elegível para publicação imediata pelo job.

#### 5. Tabela `inbox_messages` (Transactional Inbox)
* **Inserção (Apenas quando a requisição tem origem no consumidor SQS)**:
  - `consumer_name`: Identificador do consumidor (ex: `'wager-transactions-consumer'`).
  - `message_id`: ID da mensagem do SQS / `eventId`.
  - `payload_hash`: SHA-256 do payload.
  - `received_at` e `processed_at`: Timestamps de processamento.
* **Garantia**: Chave primária composta `(consumer_name, message_id)` impede duplicidade de processamento se o SQS redelivery entregar a mesma mensagem mais de uma vez.

---

### 4.3. Ciclo de Despacho na Fila SQS (`OutboxPublisherJob`)

1. O job executa a cada **1.000 ms** (1 segundo).
2. Executa a query com bloqueio pessimista sem travar outras instâncias:
   ```sql
   SELECT * FROM outbox_messages
   WHERE published_at IS NULL AND next_attempt_at <= NOW()
   ORDER BY occurred_at ASC
   LIMIT 50
   FOR UPDATE SKIP LOCKED;
   ```
3. Para cada mensagem:
   - Serializa o `payload` para JSON.
   - Envia ao AWS SQS com parâmetros FIFO:
     - `QueueUrl`: URL configurada da fila SQS FIFO.
     - `MessageBody`: JSON do evento.
     - `MessageGroupId`: `outbox_message.aggregate_id` (garante ordem estrita por carteira/transação).
     - `MessageDeduplicationId`: `outbox_message.id` (impede duplicação em janela de 5 minutos do SQS).
   - Se o SQS confirmar o recebimento (`SendMessageCommand` OK):
     ```sql
     UPDATE outbox_messages
     SET published_at = NOW()
     WHERE id = :id;
     ```
   - Se ocorrer erro (ex: indisponibilidade transitória do broker):
     ```sql
     UPDATE outbox_messages
     SET attempts = attempts + 1,
         next_attempt_at = NOW() + (exponential_backoff),
         last_error = :errorMessage
     WHERE id = :id;
     ```

---

### 4.4. Ciclo de Consumo e Execução do Evento (`SqsConsumerService`)

1. O serviço mantém um loop contínuo de **Long Polling** via `ReceiveMessageCommand` com:
   - `WaitTimeSeconds = 5`
   - `VisibilityTimeout = 30`
   - `MaxNumberOfMessages = 5`
2. Ao receber mensagens:
   - Valida a estrutura através de `SqsWagerMessageDto` e `class-validator`.
   - Se o payload estiver corrompido: registra log de erro e não confirma ACK (permitindo expiração e encaminhamento para DLQ - Dead Letter Queue).
   - Se válido, invoca o caso de uso `ProcessWagerTransactionUseCase.execute` passando `consumerName` e `consumerMessageId`.
3. O caso de uso executa com garantia atômica:
   - Consulta e insere na tabela `inbox_messages`.
   - Se já foi processada no inbox: retorna sem repetir alterações financeiras.
   - Se for nova mensagem: atualiza `wallets`, `wager_transactions`, `wallet_ledger_entries` e insere novos eventos no `outbox_messages`.
4. **Confirmação (ACK) no SQS**:
   - Apenas **após o commit bem-sucedido no PostgreSQL**, o serviço executa:
     ```typescript
     await this.client.send(
       new DeleteMessageCommand({
         QueueUrl: envConfig.sqs.queueUrl,
         ReceiptHandle: msg.ReceiptHandle,
       }),
     );
     ```
   - Se ocorrer qualquer exceção antes do commit, o `DeleteMessageCommand` não é executado. Ao fim do `VisibilityTimeout`, o SQS disponibiliza a mensagem novamente para reprocessamento.

---

## 5. Resumo das Respostas HTTP

| Código HTTP | Condição | Significado |
| :---: | :--- | :--- |
| **`200 OK`** | Transação executada com sucesso (`PROCESSED`) ou replay idêntico de transação anterior. | Operação financeira liquidada e comitada no banco de dados. |
| **`202 Accepted`** | Transação `REFUND` ou `ROLLBACK` cuja aposta original ainda não chegou (`PENDING_REFERENCE`). | A requisição foi registrada com sucesso e aguardará resolução assíncrona. |
| **`400 Bad Request`** | Header `Idempotency-Key` ausente ou campos do payload inválidos pelo DTO. | Requisição malformada. |
| **`409 Conflict`** | O mesmo `Idempotency-Key` ou `(providerId, externalTransactionId)` reenviado com parâmetros diferentes. | Conflito de integridade de idempotência (`IdempotencyPayloadMismatch`). |
| **`422 Unprocessable Entity`** | Violação de regras financeiras do domínio (ex: `INSUFFICIENT_FUNDS`, referência com rodada divergente, etc.). | A transação foi salva no banco como `REJECTED` para fins de auditoria. |
| **`500 Internal Server Error`** | Erro inesperado de banco de dados ou infraestrutura. | Falha de execução interna. |
