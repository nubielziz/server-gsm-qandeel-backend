// Builds the real API (AppModule + the same bootstrap as main.ts) for integration tests, on Fastify inject.
// Tests add controllers and providers of their own and may override the environment, never the pipeline.
import 'reflect-metadata';
import type { ModuleMetadata, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../../src/app.module';
import { configureApp, createAppAdapter } from '../../src/app.bootstrap';
import { APP_CONFIG, type AppConfig, parseEnv } from '../../src/config';
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

/** What a test can change about the app. */
export interface TestAppOptions {
  /** Environment variables on top of `NODE_ENV=test`. */
  readonly env?: Record<string, string>;
  /** Controllers added to the root module (use the sample ones in routes.ts or your own). */
  readonly controllers?: Type<unknown>[];
  readonly providers?: ModuleMetadata['providers'];
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
  const config = parseEnv({ NODE_ENV: 'test', ...options.env });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
    providers: options.providers ?? [],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .overrideProvider(LOG_DESTINATION)
    .useValue(logSink)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createAppAdapter(config), { bufferLogs: true });
  await configureApp(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, config, close: () => app.close() };
}
