// Creates the Nest application for the offline scripts (gen-openapi.ts) and reports every network connection it tried
// to open on the way. It keeps "the generator needs no Postgres, Redis or S3" a check that fails (decisions 008, 009).
import type { INestApplication, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createAppAdapter } from '../../src/app.bootstrap';
import type { AppConfig } from '../../src/config';
import { forbidConnections } from './forbid-connections';

/** What {@link createOfflineApp} found out: the result of the work done on the application and the attempts. */
export interface OfflineRun<T> {
  /** What the `use` callback returned. */
  readonly value: T;
  /** Every network connection the application tried to open, as text; empty when it stayed offline. */
  readonly attempts: readonly string[];
}

/**
 * Creates the application WITHOUT `init()` or `listen()`, runs `use` on it, and reports every network connection that
 * was attempted by the time the event loop has had a turn.
 *
 * Why: the OpenAPI generator (decision 009) must run in CI with no Postgres, Redis or S3, so a provider that opens a
 * connection while the application is created has to fail it. ioredis, and BullMQ on top of it, does not open its
 * socket inside the constructor but on `process.nextTick`; reading the attempts straight after `NestFactory.create`
 * (or after `use`) sees none. The one `setImmediate` below lets those ticks run first. A client built with
 * `lazyConnect` connects later (in `onModuleInit`), which this script never runs, so it is not an attempt.
 *
 * Side effects: refuses every `node:net` connection for the rest of the process (see `forbidConnections`), so call it
 * only from a script that exits when it is done.
 *
 * @param rootModule the root Nest module to create
 * @param config the process configuration, for the HTTP adapter options
 * @param use the work to do on the created application, such as building the OpenAPI documents (synchronous)
 * @returns what `use` returned and the connection attempts, as text
 * @throws {Error} when the application cannot be created (a provider factory threw)
 * @see scripts/gen-openapi.ts
 */
export async function createOfflineApp<T>(
  rootModule: Type<unknown>,
  config: AppConfig,
  use: (app: INestApplication) => T,
): Promise<OfflineRun<T>> {
  const attempts = forbidConnections();
  const app = await NestFactory.create(rootModule, createAppAdapter(config), { logger: false, abortOnError: false });
  const value = use(app);
  // Yield once: ioredis opens its socket on process.nextTick, which only runs after the code above has returned.
  await new Promise<void>((resolve) => setImmediate(resolve));
  // A copy: the guard stays armed, and attempts after this point belong to whoever keeps running.
  return { value, attempts: [...attempts] };
}
