import { Module } from '@nestjs/common';
import { PersistenceModule } from './infrastructure/persistence/persistence.module.js';
import { ApplicationModule } from './application/application.module.js';
import { MessagingModule } from './infrastructure/messaging/messaging.module.js';
import { HttpModule } from './infrastructure/http/http.module.js';
import { ObservabilityModule } from './infrastructure/observability/observability.module.js';

@Module({
  imports: [
    PersistenceModule,
    ApplicationModule,
    MessagingModule,
    HttpModule,
    ObservabilityModule,
  ],
})
export class AppModule {}
