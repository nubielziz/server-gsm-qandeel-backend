// Root module of the API process (decision 016): config, logging, metrics, the database, the error filter and the 12
// domain modules. Other infrastructure modules (Redis, queues, storage, security) are added by their own features.
import { Module } from '@nestjs/common';
import { ErrorsModule } from './common/errors';
import { ConfigModule } from './config';
import { DbModule } from './infra/db';
import { LoggingModule } from './infra/logging';
import { MetricsModule } from './infra/metrics';
import { CatalogModule } from './modules/catalog';
import { CommissionsModule } from './modules/commissions';
import { CustomersModule } from './modules/customers';
import { HealthModule } from './modules/health';
import { IdentityModule } from './modules/identity';
import { MoneyModule } from './modules/money';
import { OrdersModule } from './modules/orders';
import { PlatformModule } from './modules/platform';
import { RiskModule } from './modules/risk';
import { StorefrontModule } from './modules/storefront';
import { SuppliersModule } from './modules/suppliers';
import { SupportModule } from './modules/support';

/**
 * Root Nest module of the API process.
 *
 * Why: the API and the worker share config, logging, metrics and the database; the API adds the problem+json filter and
 * every domain module (one per map domain, `scripts/module-map.mjs`).
 */
@Module({
  imports: [
    ConfigModule,
    LoggingModule.forRoot({ service: 'api' }),
    MetricsModule,
    DbModule,
    ErrorsModule,
    IdentityModule,
    PlatformModule,
    MoneyModule,
    CatalogModule,
    OrdersModule,
    SuppliersModule,
    HealthModule,
    CommissionsModule,
    CustomersModule,
    StorefrontModule,
    SupportModule,
    RiskModule,
  ],
})
export class AppModule {}
