# observability Specification

## Purpose

Especificar o comportamento observável das sondas de saúde, correlação ponta a ponta, padronização de erros HTTP, logs estruturados, coleta e exposição de métricas operacionais/Prometheus e encerramento gracioso da capacidade `observability`, retratando fielmente a implementação atual.

## Requirements

### Requirement: Sondas públicas de saúde e prontidão
O sistema SHALL expor os endpoints públicos `GET /health/live` e `GET /health/ready` sem exigir autenticação, informando a vivacidade do processo e a conectividade ativa com o PostgreSQL e a fila principal SQS FIFO.

#### Scenario: Verificação de vivacidade do processo
- **WHEN** um cliente envia `GET /health/live`
- **THEN** o sistema responde `200 OK` com `{ status: "ok", uptime, timestamp }`, onde `uptime` representa o tempo de atividade do processo em segundos e `timestamp` está em formato ISO-8601

#### Scenario: Prontidão confirmada com banco de dados e mensageria conectados
- **WHEN** um cliente envia `GET /health/ready` e tanto a consulta `SELECT 1` no PostgreSQL quanto a leitura de atributos da fila `SQS_WAGER_TRANSACTIONS_QUEUE_URL` no SQS respondem com sucesso
- **THEN** o sistema responde `200 OK` com `{ status: "ok", postgres: "connected", sqs: "connected", timestamp }`

#### Scenario: Prontidão recusada quando PostgreSQL ou SQS falham
- **WHEN** um cliente envia `GET /health/ready` e a verificação do PostgreSQL, a verificação do SQS ou ambas falham
- **THEN** o sistema executa ambas as verificações de forma independente e responde `503 Service Unavailable` com `{ status: "error", postgres, sqs, timestamp }`, preenchendo `"disconnected: <mensagem>"` em cada dependência indisponível e mantendo `"connected"` na dependência saudável

### Requirement: Correlação ponta a ponta de requisições, mensagens e eventos
O sistema SHALL resolver e propagar um `correlationId` único ao longo de requisições HTTP, consumo assíncrono SQS FIFO, logs estruturados e eventos de integração gravados em `outbox_messages`.

#### Scenario: Resolução e devolução do header X-Correlation-Id em requisições HTTP
- **WHEN** uma requisição HTTP válida percorre o pipeline da aplicação com ou sem o header `X-Correlation-Id`
- **THEN** o sistema utiliza `X-Correlation-Id` quando presente, recorre ao header `Idempotency-Key` como primeiro fallback ou gera um UUID v4 quando ambos estão ausentes
- **AND** devolve o valor resolvido no header de resposta `X-Correlation-Id` e propaga o mesmo `correlationId` aos logs operacionais e aos eventos gravados em `outbox_messages`

#### Scenario: Derivação de correlationId no consumo SQS e em fluxos internos
- **WHEN** uma transação é recebida pela fila SQS FIFO ou executada internamente na abertura de carteira com saldo positivo (`OPENING`) e no reprocessamento de referências pendentes
- **THEN** o fluxo SQS deriva `correlationId` priorizando `messageId` do envelope JSON, `data.idempotencyKey` e `MessageId` nativo do SQS, enquanto os fluxos internos geram um UUID v4 dedicado para seus eventos e logs

#### Scenario: Ausência de correlação gerada em falhas de validação anteriores à interceptação
- **WHEN** uma requisição HTTP sem o header `X-Correlation-Id` falha na validação de parâmetros de rota (como UUID inválido) ou de corpo de entrada antes da etapa de interceptação de correlação
- **THEN** a resposta `400 Bad Request` retorna `correlationId = "none"` no corpo de erro e omite o header `X-Correlation-Id` na resposta (ressalva registrada para futura resolução antecipada na entrada HTTP)

### Requirement: Padronização global de respostas de erro HTTP
O sistema SHALL retornar todas as respostas de erro HTTP no envelope JSON padronizado contendo `statusCode`, `error`, `message`, `failureCode` opcional, `path`, `correlationId` e `timestamp` em formato ISO-8601.

#### Scenario: Formatação de erros de validação, não encontrado, conflito e regra de negócio
- **WHEN** uma requisição HTTP falha com erro HTTP conhecido (`400 Bad Request`, `404 Not Found`, `409 Conflict` ou `422 Unprocessable Entity`)
- **THEN** o sistema responde com o respectivo código HTTP e corpo `{ statusCode, error, message, failureCode?, path, correlationId, timestamp }`, preservando `message` (string ou lista de erros de validação) e `failureCode` quando informado pela operação

#### Scenario: Tratamento de exceções internas não mapeadas
- **WHEN** ocorre uma exceção não mapeada como erro HTTP durante o atendimento de uma requisição
- **THEN** o sistema responde `500 Internal Server Error` com `error = "Internal Server Error"`, registra a stack trace em log de erro quando a falha é instância de `Error`, e retorna `error.message` no campo `message` ou `"Erro interno do servidor"` para valores lançados que não sejam `Error` (ressalva registrada para futura sanitização de detalhes internos em respostas `500`)

### Requirement: Emissão de logs estruturados em JSON nos fluxos críticos
O sistema SHALL registrar logs estruturados em JSON contendo o campo `event` e metadados de rastreamento nos fluxos HTTP, de transações de apostas, de reconciliação contábil e de mensageria, sem expor credenciais ou payloads brutos completos.

#### Scenario: Registro de conclusão de requisições HTTP bem-sucedidas
- **WHEN** uma requisição HTTP conclui sua execução sem lançar exceção
- **THEN** o sistema emite log JSON com `event = "HTTP_REQUEST_COMPLETED"` contendo `{ event, method, url, statusCode, durationMs, correlationId }`, não emitindo esse registro quando a requisição termina por exceção (ressalva registrada para futura emissão também em respostas de erro)

#### Scenario: Rastreamento estruturado do ciclo de vida de transações de apostas
- **WHEN** o processamento de uma transação de aposta inicia e termina via HTTP ou SQS FIFO
- **THEN** o sistema registra `TRANSACTION_PROCESSING_STARTED` no início e registra o desfecho com `correlationId` e `durationMs` por meio de `TRANSACTION_PROCESSED`, `TRANSACTION_PENDING_REFERENCE`, `TRANSACTION_REJECTED` (incluindo `failureCode`), `TRANSACTION_IDEMPOTENT_REPLAY`, `TRANSACTION_LOCK_COLLISION_RESOLVED` (ao resolver colisão concorrente de unicidade) ou `TRANSACTION_PROCESSING_FAILED` (em caso de falha)

#### Scenario: Auditoria de divergência contábil e eventos de workers assíncronos
- **WHEN** a reconciliação de carteira encontra saldo inconsistente ou os workers assíncronos processam mensagens e falhas individuais
- **THEN** o sistema emite logs JSON `WALLET_RECONCILIATION_DIVERGENCE`, `SQS_MESSAGE_PAYLOAD_INVALID`, `SQS_MESSAGE_PROCESSING_FAILED`, `OUTBOX_MESSAGE_PUBLISHED`, `OUTBOX_MESSAGE_PUBLISH_FAILED` e `PENDING_REFERENCES_REPROCESSED` (mantendo logs em texto livre apenas em bootstrap, falhas gerais de ciclo e avisos de fallback de métricas; ressalva registrada para futura padronização integral)

### Requirement: Coleta de telemetria operacional e janela deslizante de latência
O sistema SHALL contabilizar transações por status, duplicatas idempotentes, colisões de concorrência, retentativas por componente e estatísticas de latência de processamento sobre janela deslizante das últimas `5000` amostras.

#### Scenario: Contabilização de transações novas, falhas inesperadas e replays idempotentes
- **WHEN** uma transação de aposta termina em `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE` com `idempotentReplay = false`, ou falha por exceção inesperada distinta de `404`/`409`/`422`
- **THEN** o sistema incrementa o contador do respectivo status (`FAILED` para exceções inesperadas) e adiciona `durationMs` à janela de latência
- **AND** quando `idempotentReplay = true`, incrementa apenas `duplicatesDetected` sem registrar nova amostra de latência

#### Scenario: Contabilização de colisões de chave única e retentativas de mensageria
- **WHEN** ocorrem violações PostgreSQL `23505` / `uq_wager_tx*`, exceções após o parsing JSON no consumidor SQS, falhas de publicação na outbox ou itens processados pelo job de referências pendentes
- **THEN** o sistema incrementa respectivamente `lockConflicts` e os contadores de retentativa `sqs`, `outbox` e `pending_reference` (ressalvas registradas quanto à contabilização de dupla reversão em `lockConflicts`, ausência de incremento em falhas de validação do envelope SQS e inclusão de expirações por TTL em `pending_reference`)

#### Scenario: Cálculo de percentis e descarte FIFO na janela de latência
- **WHEN** amostras `durationMs >= 0` são coletadas até ou além da capacidade de `5000` registros
- **THEN** o sistema descarta a amostra mais antiga sempre que o buffer ultrapassa `5000` itens e calcula `{ count, min, avg, max, p50, p95, p99 }` arredondados a 1 casa decimal, retornando todos os campos iguais a `0` quando não há amostras (ressalva registrada quanto à retenção volátil em memória por instância)

### Requirement: Consulta de métricas operacionais em JSON e degradação graciosa
O sistema SHALL expor `GET /metrics`, `GET /metrics/transactions`, `GET /metrics/messaging` e `GET /metrics/latency` consolidando contagens persistidas no PostgreSQL, atributos da DLQ no SQS e métricas em memória sem falhar quando dependências externas estiverem indisponíveis.

#### Scenario: Consulta do snapshot consolidado e dos endpoints especializados
- **WHEN** um cliente consulta `GET /metrics`, `GET /metrics/transactions`, `GET /metrics/messaging` ou `GET /metrics/latency` com PostgreSQL e SQS operacionais
- **THEN** o sistema responde `200 OK` combinando contagens reais de `wager_transactions` agrupadas por `status` no PostgreSQL (mantendo `FAILED` da memória da instância), lag de `outbox_messages` (`pendingCount` e `oldestPendingAgeSeconds` para `published_at IS NULL`), mensagens visíveis/invisíveis da fila `SQS_WAGER_TRANSACTIONS_DLQ_URL` (`status = "connected"`) e contadores de duplicatas, conflitos, retries e latência (ressalvas registradas quanto à mescla banco/memória e às chaves distintas de `retries` entre `/metrics` e `/metrics/messaging`)

#### Scenario: Degradação graciosa sem banco inicializado ou com falha no PostgreSQL e SQS
- **WHEN** o PostgreSQL não está inicializado ou falha ao executar as consultas de agregação, ou o cliente SQS não está configurado ou falha ao consultar `SQS_WAGER_TRANSACTIONS_DLQ_URL`
- **THEN** todos os endpoints `/metrics/**` continuam respondendo `200 OK` utilizando a contagem em memória para transações por status, `{ pendingCount: 0, oldestPendingAgeSeconds: 0 }` para `outboxLag` e `dlq` zerada com `status = "not_configured"` ou `"unavailable: <mensagem>"`

### Requirement: Exportação de métricas no formato texto Prometheus
O sistema SHALL expor `GET /metrics/prometheus` retornando `200 OK` com `Content-Type: text/plain; version=0.0.4; charset=utf-8` e séries formatadas com cabeçalhos `# HELP` e `# TYPE`.

#### Scenario: Raspagem de séries operacionais e financeiras no endpoint Prometheus
- **WHEN** um coletor envia `GET /metrics/prometheus`
- **THEN** o sistema responde `200 OK` em texto plano contendo `process_uptime_seconds` (`gauge`), `wagering_transactions_total{status="..."}` (`counter`), `wagering_duplicates_detected_total` (`counter`), `wagering_lock_conflicts_total` (`counter`), `wagering_retries_total{component="sqs_consumer"|"outbox_publisher"|"pending_references"}` (`counter`), `wagering_dlq_messages{type="visible"|"not_visible"}` (`gauge`), `wagering_outbox_pending_messages` (`gauge`), `wagering_outbox_lag_seconds` (`gauge`) e `wagering_processing_latency_ms` (`summary` com quantis `0.5`, `0.95`, `0.99`, `wagering_processing_latency_ms_avg` e `wagering_processing_latency_ms_count`; ressalva registrada quanto ao uso de `_avg` sem `_sum`)

### Requirement: Encerramento gracioso de servidor e workers assíncronos
O sistema SHALL habilitar hooks de encerramento para sinais de término (`SIGTERM` e `SIGINT`), interrompendo novos ciclos de polling e agendamentos periódicos dos workers assíncronos durante o desligamento da aplicação.

#### Scenario: Interrupção de polling e timers ao receber sinal de desligamento
- **WHEN** o processo recebe `SIGTERM` ou `SIGINT` e aciona o encerramento dos módulos
- **THEN** o consumidor da fila SQS sinaliza parada para encerrar seu loop de long polling ao fim da iteração corrente e os jobs periódicos de publicação da outbox e de reprocessamento de referências pendentes limpam seus intervalos de execução (ressalva registrada quanto à ausência de espera explícita por promessas de lotes em voo no fechamento)
