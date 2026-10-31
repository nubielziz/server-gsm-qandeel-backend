// Logging module (decision 012): pino through nestjs-pino on the Fastify adapter, shared by the API and the worker.
// The request id comes from our own async context (a pino mixin), so no HTTP middleware is needed for it.
import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { APP_CONFIG, type AppConfig } from '../../config';
import { type ServiceName, buildPinoOptions, chooseDestination } from './pino-options';

/**
 * Injection token for a custom log destination (a Writable). Unset in production and development; tests override it
 * to capture log lines.
 *
 * Why: tests capture log lines to assert on request ids and redaction.
 */
export const LOG_DESTINATION = Symbol.for('gsm.LOG_DESTINATION');

/**
 * Installs nestjs-pino with the project's pino options.
 *
 * Why: one logger for Nest's own messages, application code (`Logger`, `PinoLogger`) and our hooks, with redaction and
 * masking applied everywhere (decision 012).
 *
 * Notes: `forRoutes: []` switches nestjs-pino's per-request middleware off on purpose. Its default route pattern
 * (`{/*splat}`) does not match under Nest 12 + Fastify, so relying on it would silently drop the request context;
 * the request id is bound by the `requestIdMixin` instead, and the access log is written by `registerAccessLog`.
 * nestjs-pino keeps one root logger per process: the first module to start decides the level and the destination.
 */
@Module({})
export class LoggingModule {
  /**
   * @param options which process is logging (`api` or `worker`)
   * @returns the dynamic module; import it once in the root module of each process
   */
  static forRoot(options: { service: ServiceName }): DynamicModule {
    return {
      module: LoggingModule,
      imports: [
        LoggerModule.forRootAsync({
          providers: [{ provide: LOG_DESTINATION, useValue: undefined }],
          inject: [APP_CONFIG, LOG_DESTINATION],
          useFactory: async (config: AppConfig, injected: DestinationStream | undefined) => {
            const pinoOptions = { ...buildPinoOptions(config, options.service), autoLogging: false };
            const destination = await chooseDestination(config, injected);
            return {
              forRoutes: [],
              pinoHttp: destination
                ? ([pinoOptions, destination] as [typeof pinoOptions, DestinationStream])
                : pinoOptions,
            };
          },
        }),
      ],
      exports: [LoggerModule],
    };
  }
}
