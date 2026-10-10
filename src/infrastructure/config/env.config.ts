export interface PostgresConfig {
  database: string;
  user: string;
  password: string;
  host: string;
  port: number;
}

export interface AwsSqsConfig {
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  queueUrl: string;
  dlqUrl: string;
}

export interface AppEnvConfig {
  port: number;
  postgres: PostgresConfig;
  sqs: AwsSqsConfig;
}

function getRequiredEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (!value) {
    throw new Error(`Configuração de ambiente obrigatória ausente: ${key}`);
  }
  return value;
}

export function loadEnvConfig(): AppEnvConfig {
  return {
    port: Number(process.env.PORT) || 3000,
    postgres: {
      database: getRequiredEnv('POSTGRES_PAY_CHALLENGE_DB', 'pay-challenge'),
      user: getRequiredEnv('POSTGRES_PAY_CHALLENGE_USER', 'api-pay-challenge'),
      password: getRequiredEnv('POSTGRES_PAY_CHALLENGE_PASSWORD', '123456'),
      host: process.env.POSTGRES_HOST || 'localhost',
      port: Number(process.env.POSTGRES_PORT) || 5432,
    },
    sqs: {
      region: getRequiredEnv('AWS_REGION', 'us-east-1'),
      endpoint: getRequiredEnv('AWS_ENDPOINT', 'http://localhost:4566'),
      accessKeyId: getRequiredEnv('AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: getRequiredEnv('AWS_SECRET_ACCESS_KEY', 'test'),
      queueUrl: getRequiredEnv(
        'SQS_WAGER_TRANSACTIONS_QUEUE_URL',
        'http://localhost:4566/000000000000/wager-transactions.fifo',
      ),
      dlqUrl: getRequiredEnv(
        'SQS_WAGER_TRANSACTIONS_DLQ_URL',
        'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
      ),
    },
  };
}

export const envConfig = loadEnvConfig();
