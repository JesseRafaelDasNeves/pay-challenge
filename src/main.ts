import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { envConfig } from './infrastructure/config/env.config.js';
import { HttpExceptionFilter } from './infrastructure/http/filters/http-exception.filter.js';
import { LoggingInterceptor } from './infrastructure/http/interceptors/logging.interceptor.js';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });

  // Habilita graceful shutdown hooks (SIGTERM, SIGINT)
  app.enableShutdownHooks();

  // Configuração global de validação estrita com class-validator
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      stopAtFirstError: false,
    }),
  );

  // Filtro de exceção global e interceptor de observabilidade
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  await app.listen(envConfig.port);
  logger.log(
    `Distributed Wagering Processor rodando na porta ${envConfig.port} [PID: ${process.pid}]`,
  );
}

void bootstrap();
