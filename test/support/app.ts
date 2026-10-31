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
import { DbModule } from '../../src/infra/db';
import { LOG_DESTINATION } from '../../src/infra/logging';
import { logSink } from './log-sink';

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

/** What a test can change about the app. */
export interface TestAppOptions {
  /** Environment variables on top of `NODE_ENV=test`. */
  readonly env?: Record<string, string>;
  /** Controllers added to the root module (use the sample ones in routes.ts or your own). */
  readonly controllers?: Type<unknown>[];
  readonly providers?: ModuleMetadata['providers'];
  /** Modules added to the root module, for example a global one that provides a token a real module will provide later. */
  readonly imports?: ModuleMetadata['imports'];
  /** Replace the database module with an empty one (no pool, no `postgres` health indicator). */
  readonly withoutDatabase?: boolean;
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
  const config = parseEnv({ NODE_ENV: 'test', DATABASE_URL_TEST: TEST_DATABASE_URL, ...options.env });
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
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createAppAdapter(config), { bufferLogs: true });
  await configureApp(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, config, close: () => app.close() };
}
