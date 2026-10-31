// Builds the real API (AppModule + the same bootstrap as main.ts) for integration tests, on Fastify inject.
// Tests add controllers and providers of their own and may override the environment, never the pipeline.
import 'reflect-metadata';
import { Module, type ModuleMetadata, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../../src/app.module';
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
import { IpRulesModule } from '../../src/modules/identity/security/ip-rules/ip-rules.module';
import { MaintenanceModule, SettingsModule } from '../../src/modules/platform';
import { logSink } from './log-sink';
import { testInstanceEnv } from './env';

/** A complete production environment for tests that need `NODE_ENV=production` rules. */
export const PRODUCTION_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  ERRORS_BASE_URL: 'https://errors.gsm.example',
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
  LOG_LEVEL: 'warn',
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
 * permissions, the guard dispatcher), the settings readers, and the IP rules and maintenance stages of the pipeline. An
 * app built without the database or the infrastructure has no guards, and those stages do nothing.
 */
@Module({})
class NoSecurityModule {}

/** The modules that read Postgres and the cache on every request: replaced when either is left out. */
const NEEDS_DATABASE_AND_CACHE = [SecurityModule, SettingsModule, MaintenanceModule, IpRulesModule];
/** The pipeline module that only uses the cache Redis and the rate limiter: replaced when the infrastructure is. */
const NEEDS_INFRASTRUCTURE = [PublicIpLimitModule];

/** What a test can change about the app. */
export interface TestAppOptions {
  /** Environment variables on top of `NODE_ENV=test`. */
  readonly env?: Record<string, string>;
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
  /** Called for every route Fastify registers (method `string | string[]`, url as registered), before `init()` ends. */
  readonly onRoute?: (route: { method: string | readonly string[]; url: string }) => void;
}

/** A running test app. */
export interface TestApp {
  readonly app: NestFastifyApplication;
  readonly config: AppConfig;
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
  const builder = Test.createTestingModule({
    imports: [AppModule, ...(options.imports ?? [])],
    controllers: options.controllers ?? [],
    providers: options.providers ?? [],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(LOG_DESTINATION)
    .useValue(logSink);
  if (options.withoutDatabase) builder.overrideModule(DbModule).useModule(NoDatabaseModule);
  // The security stack and the IP rules and maintenance stages read the database and the cache: without either, they go.
  if (options.withoutDatabase || options.withoutInfrastructure) {
    for (const module of NEEDS_DATABASE_AND_CACHE) builder.overrideModule(module).useModule(NoSecurityModule);
  }
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
  return { app, config, close: () => app.close() };
}
