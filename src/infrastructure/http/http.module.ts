import { Module } from '@nestjs/common';
import { ApplicationModule } from '../../application/application.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { WalletController } from './controllers/wallet.controller.js';
import { WageringController } from './controllers/wagering.controller.js';
import { HealthController } from './controllers/health.controller.js';
import { HttpExceptionFilter } from './filters/http-exception.filter.js';
import { LoggingInterceptor } from './interceptors/logging.interceptor.js';

@Module({
  imports: [ApplicationModule, MessagingModule],
  controllers: [WalletController, WageringController, HealthController],
  providers: [HttpExceptionFilter, LoggingInterceptor],
  exports: [HttpExceptionFilter, LoggingInterceptor],
})
export class HttpModule {}
