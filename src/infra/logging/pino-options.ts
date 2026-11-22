// pino options shared by the API and the worker (decisions 012, 054): level per environment, redaction, PII masking, safe errors and the
// request id on every line. Built from the typed config; the destination (JSON to stdout or pretty) is chosen apart.
import { hostname } from 'node:os';
import { type DestinationStream, type LoggerOptions, stdTimeFunctions } from 'pino';
import { getRequestId } from '../../common/request-id';
import type { AppConfig } from '../../config';
import { serializeLoggedError, withoutStatementTextInLine } from './error-serializer';
import { REDACT_CENSOR, REDACT_PATHS, redactLogObject } from './redaction';

/**
 * The processes that log; becomes the `service` field of every line.
 *
 * Why: one request id joins API and worker logs (decision 012); the `service` field says which process wrote a line.
 */
export type ServiceName = 'api' | 'worker';

/**
 * pino mixin: adds `requestId` to every line written while a request (or a job that carries one) is being handled.
 *
 * Why: decision 012 binds the request id to every log line, so one id joins API, worker and supplier logs. Returns a
 * fresh object each time because pino merges the log call into it.
 *
 * @returns `{ requestId }`, or `{}` outside a request
 */
export function requestIdMixin(): { requestId?: string } {
  const requestId = getRequestId();
  return requestId ? { requestId } : {};
}

/**
 * Builds the pino options of a process.
 *
 * Why: decision 012: one place defines level, redaction, masking and the request id for both processes. Decision 054 adds three
 * layers against statements and values in a line: an `err` serializer that rebuilds a database failure from the original error, a
 * `formatters.log` walk that applies the secret-name rule and the personal-data masks at every depth, and a `streamWrite` check that
 * removes any statement text from the finished line.
 *
 * @param config the process configuration (level comes from `LOG_LEVEL`, else info/debug/warn by environment)
 * @param service which process is logging
 * @returns options for pino / pino-http
 */
export function buildPinoOptions(config: AppConfig, service: ServiceName): LoggerOptions {
  return {
    level: config.log.level,
    base: { service, pid: process.pid, hostname: hostname() },
    timestamp: stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
    serializers: { err: serializeLoggedError },
    formatters: { log: redactLogObject },
    hooks: { streamWrite: withoutStatementTextInLine },
    mixin: requestIdMixin,
  };
}

/**
 * Chooses where logs go: an injected stream (tests), pretty text in development, otherwise pino's default (JSON to
 * stdout, one line per entry).
 *
 * Why: decision 012 wants JSON in production and pino-pretty only in development; pino-pretty is a dev dependency,
 * so it is imported only in development, and runs in-process (no worker thread) to stay simple under Bun.
 *
 * @param config the process configuration
 * @param injected a stream supplied through the `LOG_DESTINATION` token
 * @returns the destination, or `undefined` for pino's default
 */
export async function chooseDestination(
  config: AppConfig,
  injected: DestinationStream | undefined,
): Promise<DestinationStream | undefined> {
  if (injected) return injected;
  if (config.env !== 'development') return undefined;
  const { default: pretty } = await import('pino-pretty');
  return pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service', sync: true });
}
