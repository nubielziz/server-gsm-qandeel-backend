// Global Nest module that provides the frozen application config under APP_CONFIG (decision 013).
// Shared by the API (app.module.ts) and the worker (worker.module.ts); no other file reads process.env.
import { Global, Module } from '@nestjs/common';
import { loadConfig } from './env';

/**
 * Injection token of the typed, frozen {@link AppConfig}.
 *
 * Why: decision 013 makes the config a provider so tests can replace it; inject with
 * `@Inject(APP_CONFIG) private readonly config: AppConfig` (import `AppConfig` with `import type`).
 */
export const APP_CONFIG = Symbol.for('gsm.APP_CONFIG');

/**
 * Provides {@link APP_CONFIG} to every module (global).
 *
 * Why: every feature needs settings; parsing once at boot (decision 013) stops a bad deploy before the first request.
 *
 * @throws {ConfigError} while the module is being built, when the environment is invalid
 */
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
