// Reports unexpected server errors to Sentry (decision 015, feature 24D). Off, and never initialised, without SENTRY_DSN.
import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit, Optional } from '@nestjs/common';
import * as Sentry from '@sentry/bun';
import { APP_CONFIG, type AppConfig } from '../../config';
import { scrubEvent } from './scrub';

/** Injection token of {@link ErrorReporterOptions} (tests replace the transport; the module provides none). */
export const ERROR_REPORTER_OPTIONS = Symbol.for('gsm.ERROR_REPORTER_OPTIONS');

/** The SDK's transport factory type, so a test can collect events in memory instead of sending them. */
export type SentryTransportFactory = NonNullable<Sentry.BunOptions['transport']>;

/** Settings of {@link ErrorReporter} that only tests change. */
export interface ErrorReporterOptions {
  /** Replaces the HTTP transport (an in-memory one in tests). */
  readonly transport?: SentryTransportFactory;
}

/** Where an error happened; every field becomes a Sentry tag. */
export interface ErrorContext {
  readonly process: 'api' | 'worker';
  readonly requestId?: string | undefined;
  readonly surface?: string | undefined;
  readonly route?: string | undefined;
  readonly method?: string | undefined;
  readonly code?: string | undefined;
  readonly queue?: string | undefined;
  readonly job?: string | undefined;
}

/** How long a shutdown waits for pending events to leave. */
const CLOSE_TIMEOUT_MS = 2000;

/**
 * Sends unexpected server errors (an unhandled 5xx, a job that failed for good) to Sentry, scrubbed of personal data.
 *
 * Why: decision 015 makes Sentry optional and "unexpected 5xx only"; the owner turns it on with `SENTRY_DSN` to be told about
 * failures nobody reported. The logs and `api_errors_total` stay the source of truth; this only adds a notification channel.
 * Only manual capture is used: no tracing, no default integrations, no request data, no personal data (see {@link scrubEvent}).
 *
 * Side effects: with a DSN, `onModuleInit` initialises the SDK (global state, one reporter per process) and `capture` queues an
 * event to Sentry's servers; `onApplicationShutdown` flushes for up to 2 s. Without a DSN nothing is initialised, no timer runs and
 * no connection is made. A failure inside the SDK is logged at warn level and never reaches the caller.
 *
 * @see docs/decisions/015-observability.md and docs/OPERATIONS.md section 6
 */
@Injectable()
export class ErrorReporter implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ErrorReporter.name);
  private active = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(ERROR_REPORTER_OPTIONS) private readonly options?: ErrorReporterOptions,
  ) {}

  /** Initialises the SDK when `SENTRY_DSN` is set; does nothing otherwise. */
  onModuleInit(): void {
    const dsn = this.config.observability.sentryDsn;
    if (dsn === undefined) return;
    try {
      Sentry.init({
        dsn,
        environment: this.config.env,
        release: `${this.config.build.version}+${this.config.build.commit}`,
        // Errors only: nothing is hooked in by itself, nothing is traced, no personal data is attached by the SDK.
        defaultIntegrations: false,
        // SDK 11 replaced `sendDefaultPii` with `dataCollection`: everything it could attach on its own is switched off.
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: false,
          httpBodies: [],
          urlQueryParams: false,
          databaseQueryData: false,
          queues: false,
          stackFrameVariables: false,
        },
        tracesSampleRate: 0,
        beforeSend: (event) => scrubEvent(event),
        ...(this.options?.transport ? { transport: this.options.transport } : {}),
      });
      this.active = true;
      this.logger.log('Sentry error reporting is on (errors only, scrubbed).');
    } catch (error) {
      this.logger.warn(`Sentry could not start; errors will not be reported: ${errorText(error)}`);
    }
  }

  /** @returns true when errors are being reported (a DSN is set and the SDK started) */
  get enabled(): boolean {
    return this.active;
  }

  /**
   * Reports one error with its context as tags.
   *
   * @param error what was thrown (any value)
   * @param context where it happened
   */
  capture(error: unknown, context: ErrorContext): void {
    if (!this.active) return;
    try {
      const tags: Record<string, string> = {};
      for (const [name, value] of Object.entries(context)) {
        if (typeof value === 'string' && value !== '') tags[name === 'requestId' ? 'request_id' : name] = value;
      }
      Sentry.withScope((scope) => {
        scope.setTags(tags);
        Sentry.captureException(error);
      });
    } catch (failure) {
      this.logger.warn(`Sentry could not record an error: ${errorText(failure)}`);
    }
  }

  /**
   * Waits until the events captured so far have left the process.
   *
   * @param timeoutMs the longest wait
   * @returns true when everything was sent (also when reporting is off)
   */
  async flush(timeoutMs: number = CLOSE_TIMEOUT_MS): Promise<boolean> {
    if (!this.active) return true;
    try {
      return await Sentry.flush(timeoutMs);
    } catch {
      return false;
    }
  }

  /** Sends the events still queued, then stops the SDK. */
  async onApplicationShutdown(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    try {
      await Sentry.close(CLOSE_TIMEOUT_MS);
    } catch (error) {
      this.logger.warn(`Sentry did not close cleanly: ${errorText(error)}`);
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
