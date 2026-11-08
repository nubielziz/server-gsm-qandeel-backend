// Builds the real API (AppModule + the same bootstrap as main.ts) for integration tests, on Fastify inject.
// Tests add controllers and providers of their own and may override the environment, never the pipeline.
import 'reflect-metadata';
import { Module, type ModuleMetadata, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../../src/app.module';
import { CLOCK, type Clock, SystemClock, TIMERS, type Timers } from '../../src/common/clock';
import { configureApp, createAppAdapter } from '../../src/app.bootstrap';
import { APP_CONFIG, type AppConfig, parseEnv } from '../../src/config';
import { TEST_DATABASE_URL } from './db';
import { CacheModule } from '../../src/infra/cache';
import { DbModule } from '../../src/infra/db';
import { LOG_DESTINATION } from '../../src/infra/logging';
import { SecurityModule } from '../../src/modules/identity';
import { QueuesModule } from '../../src/infra/queues';
import { PublicIpLimitModule, RateLimitModule } from '../../src/infra/rate-limit';
import { RedisModule } from '../../src/infra/redis';
import { StorageModule } from '../../src/infra/storage';
import { CatalogAdminModule, CatalogPricesModule } from '../../src/modules/catalog';
import { AccessAdminModule } from '../../src/modules/identity/access-admin.module';
import { ApiKeysModule } from '../../src/modules/identity/api-keys.module';
import { KycModule } from '../../src/modules/identity/kyc.module';
import { MerchantNotificationsModule } from '../../src/modules/identity/merchant-notifications.module';
import { MerchantWebhookRoutesModule } from '../../src/modules/identity/merchant-webhook-routes.module';
import { MerchantAdminModule } from '../../src/modules/identity/merchant-admin.module';
import { MerchantAuthModule } from '../../src/modules/identity/merchant-auth.module';
import { StaffAuthModule } from '../../src/modules/identity/staff-auth.module';
import { IpRulesModule } from '../../src/modules/identity/security/ip-rules/ip-rules.module';
import { HealthAdminModule } from '../../src/modules/health';
import { MoneyAdminModule } from '../../src/modules/money/money-admin.module';
import { OrderTrackingModule, OrdersAdminModule } from '../../src/modules/orders';
import { CheckoutModule } from '../../src/modules/customers';
import { ImeiCheckModule } from '../../src/modules/risk';
import { StorefrontPublicModule } from '../../src/modules/storefront';
import { SuppliersAdminModule } from '../../src/modules/suppliers';
import {
  MaintenanceModule,
  MerchantWebhooksModule,
  NotificationAdminModule,
  NotificationDeliveryModule,
  SettingsModule,
  WebhookDeliveryModule,
} from '../../src/modules/platform';
import { PlatformAdminModule } from '../../src/modules/platform/platform-admin.module';
import { logSink } from './log-sink';
import { testInstanceEnv } from './env';

/** A complete production environment for tests that need `NODE_ENV=production` rules. */
export const PRODUCTION_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  ERRORS_BASE_URL: 'https://errors.gsm.example',
  PORTAL_BASE_URL: 'https://portal.gsm.example',
  DATABASE_URL: 'postgres://app:pw@db.internal:5432/gsm',
  REDIS_QUEUE_URL: 'redis://queue.internal:6379/0',
  REDIS_CACHE_URL: 'redis://cache.internal:6379/0',
  S3_BUCKET: 'gsm-prod-files',
  S3_ACCESS_KEY_ID: 'AKIA-ID',
  S3_SECRET_ACCESS_KEY: 'secret-access-key',
  CSRF_SECRET: 'c'.repeat(40),
  TOKEN_PEPPER: 'p'.repeat(40),
  ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
  ENCRYPTION_ACTIVE_KID: 'k1',
  METRICS_TOKEN: 'm'.repeat(32),
  MAIL_SMTP_URL: 'smtps://mailer:pw@smtp.gsm.example:465',
  MAIL_FROM: 'GSM <noreply@gsm.example>',
  LOG_LEVEL: 'warn',
  TURNSTILE_SECRET_KEY: 'turnstile-secret-for-tests',
};

/**
 * Stands in for the database module: no pool and no `postgres` health indicator.
 *
 * Why: tests of the health registry itself register their own indicators and must not meet the real one.
 */
@Module({})
class NoDatabaseModule {}

/**
 * Stands in for the Redis, cache, rate-limit, queue and storage modules: no clients, no queue producers and no `redis`,
 * `redis_queue` or `storage` health indicators. It also replaces the modules of the request pipeline that need them.
 */
@Module({})
class NoInfrastructureModule {}

/**
 * Stands in for the modules that read Postgres and the cache on every request: the security stack (sessions, CSRF,
 * permissions, the guard dispatcher), the staff sign-in routes, the staff access, merchant, merchant portal, platform admin
 * and money routes, the settings readers, and the IP rules and maintenance stages of the pipeline. An app built without the
 * database or the infrastructure has no guards, and those stages do nothing. Also the empty stand-in for `withoutModules`.
 */
@Module({})
class NoSecurityModule {}

/** The modules that read Postgres and the cache on every request: replaced when either is left out. */
const NEEDS_DATABASE_AND_CACHE = [
  SecurityModule,
  SettingsModule,
  MaintenanceModule,
  IpRulesModule,
  StaffAuthModule,
  AccessAdminModule,
  MerchantAdminModule,
  PlatformAdminModule,
  MerchantAuthModule,
  ApiKeysModule,
  MerchantWebhookRoutesModule,
  KycModule,
  MerchantNotificationsModule,
  MoneyAdminModule,
  CatalogPricesModule,
  CatalogAdminModule,
  OrdersAdminModule,
  SuppliersAdminModule,
  OrderTrackingModule,
  StorefrontPublicModule,
  ImeiCheckModule,
  CheckoutModule,
  MerchantWebhooksModule,
  WebhookDeliveryModule,
  HealthAdminModule,
  NotificationAdminModule,
  NotificationDeliveryModule,
];
/** The pipeline module that only uses the cache Redis and the rate limiter: replaced when the infrastructure is. */
const NEEDS_INFRASTRUCTURE = [PublicIpLimitModule];

/** What a test can change about the app. */
export interface TestAppOptions {
  /** Environment variables on top of `NODE_ENV=test`. */
  readonly env?: Record<string, string>;
  /**
   * The clock every service reads (decision 031). Pass a `TestClock` (`test/support/clock.ts`) to set and advance time
   * instead of waiting; the default is the real system clock.
   */
  readonly clock?: Clock;
  /** The timers retries and deadlines are scheduled with (decision 031); pass `ManualTimers` to fire them by hand. */
  readonly timers?: Timers;
  /** Controllers added to the root module (use the sample ones in routes.ts or your own). */
  readonly controllers?: Type<unknown>[];
  readonly providers?: ModuleMetadata['providers'];
  /** Modules added to the root module, for example a global one that provides a token a real module will provide later. */
  readonly imports?: ModuleMetadata['imports'];
  /**
   * Replace the database module with an empty one (no pool, no `postgres` health indicator). The security stack, the
   * settings readers and the IP rules and maintenance stages, which read Postgres, go too: no guards, and those stages do
   * nothing.
   */
  readonly withoutDatabase?: boolean;
  /**
   * Replace the Redis, cache, rate-limit, queue and storage modules with empty ones (no connections, no queue producers,
   * no `redis`, `redis_queue` or `storage` health indicators). Nothing in the app may inject their services then; the
   * security stack and the pipeline stages that use them (IP rules, maintenance, per-IP limit) go too.
   */
  readonly withoutInfrastructure?: boolean;
  /**
   * Modules replaced with an empty one, wherever they are imported. A test that registers its own capability token resolver for
   * `checkout-token` or `tracking-token` leaves out the module that registers the real one (a kind has one resolver).
   */
  readonly withoutModules?: readonly Type<unknown>[];
  /** Called for every route Fastify registers (method `string | string[]`, url as registered), before `init()` ends. */
  readonly onRoute?: (route: { method: string | readonly string[]; url: string }) => void;
}

/** A running test app. */
export interface TestApp {
  readonly app: NestFastifyApplication;
  readonly config: AppConfig;
  /** The clock the app runs on: the one passed in the options, or the system clock. */
  readonly clock: Clock;
  close(): Promise<void>;
}

/**
 * Creates and initialises the API with the real module graph and HTTP pipeline.
 *
 * @param options environment, extra controllers and providers
 * @returns the app (use `app.inject(...)`), its config and a `close()` to call in `afterAll`
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  // The app's pool must use the same test database as testDb()/resetDb(), including a custom DATABASE_URL_TEST.
  const config = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL_TEST: TEST_DATABASE_URL,
    ...testInstanceEnv(),
    ...options.env,
  });
  const clock = options.clock ?? new SystemClock();
  const builder = Test.createTestingModule({
    imports: [AppModule, ...(options.imports ?? [])],
    controllers: options.controllers ?? [],
    providers: options.providers ?? [],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(LOG_DESTINATION)
    .useValue(logSink)
    .overrideProvider(CLOCK)
    .useValue(clock);
  if (options.timers) builder.overrideProvider(TIMERS).useValue(options.timers);
  if (options.withoutDatabase) builder.overrideModule(DbModule).useModule(NoDatabaseModule);
  // The security stack and the IP rules and maintenance stages read the database and the cache: without either, they go.
  if (options.withoutDatabase || options.withoutInfrastructure) {
    for (const module of NEEDS_DATABASE_AND_CACHE) builder.overrideModule(module).useModule(NoSecurityModule);
  }
  for (const module of options.withoutModules ?? []) builder.overrideModule(module).useModule(NoSecurityModule);
  if (options.withoutInfrastructure) {
    const replaced = [RedisModule, CacheModule, RateLimitModule, QueuesModule, StorageModule, ...NEEDS_INFRASTRUCTURE];
    for (const module of replaced) builder.overrideModule(module).useModule(NoInfrastructureModule);
  }
  const moduleRef = await builder.compile();
  const adapter = createAppAdapter(config);
  // Fastify only reports a route to hooks added before it is registered, i.e. before `app.init()`.
  const { onRoute } = options;
  if (onRoute) adapter.getInstance().addHook('onRoute', (route) => onRoute({ method: route.method, url: route.url }));
  const app = moduleRef.createNestApplication<NestFastifyApplication>(adapter, { bufferLogs: true });
  await configureApp(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, config, clock, close: () => app.close() };
}
