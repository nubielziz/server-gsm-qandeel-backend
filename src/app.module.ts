// Root module of the API process (decision 016): config, the clock (decision 031), logging, metrics, the infrastructure (database, Redis, cache, rate
// limits, crypto, storage, outbound HTTP, queue producers), the error filter, the request pipeline registry and the 12 domain
// modules. The API only produces work (queue producers, outbox writes). Fastify hooks (IP rules, maintenance, per-IP limit)
// register with the pipeline; sessions, guards and CSRF are added by their own feature.
import { Module } from '@nestjs/common';
import { ClockModule } from './common/clock.module';
import { ErrorsModule } from './common/errors';
import { PipelineModule } from './common/pipeline';
import { ConfigModule } from './config';
import { CacheModule } from './infra/cache';
import { CryptoModule } from './infra/crypto';
import { DbModule } from './infra/db';
import { OutboundHttpModule } from './infra/http';
import { LoggingModule } from './infra/logging';
import { MetricsModule } from './infra/metrics';
import { QueuesModule } from './infra/queues';
import { PublicIpLimitModule, RateLimitModule } from './infra/rate-limit';
import { RedisModule } from './infra/redis';
import { StorageModule } from './infra/storage';
import { CatalogAdminModule, CatalogModule } from './modules/catalog';
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
 * Why: the API and the worker share config, logging, metrics and the infrastructure modules; the API adds the
 * problem+json filter and every domain module (one per map domain, `scripts/module-map.mjs`).
 */
@Module({
  imports: [
    ConfigModule,
    ClockModule,
    LoggingModule.forRoot({ service: 'api' }),
    MetricsModule,
    DbModule,
    RedisModule,
    CacheModule,
    RateLimitModule,
    CryptoModule,
    StorageModule,
    OutboundHttpModule,
    QueuesModule,
    ErrorsModule,
    PipelineModule,
    PublicIpLimitModule,
    IdentityModule,
    PlatformModule,
    MoneyModule,
    CatalogModule,
    CatalogAdminModule,
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
