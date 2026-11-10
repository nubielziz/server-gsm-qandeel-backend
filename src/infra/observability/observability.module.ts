// Global module that gives the API and the worker the same ErrorReporter (decision 015, feature 24D).
import { Global, Module } from '@nestjs/common';
import { ERROR_REPORTER_OPTIONS, ErrorReporter, type ErrorReporterOptions } from './error-reporter';

const DEFAULT_OPTIONS: ErrorReporterOptions = {};

/**
 * Provides the process-wide {@link ErrorReporter}.
 *
 * Why: the exception filter (API) and the queue workers (worker process) report through one object that starts the SDK once.
 * `ErrorsModule` and `QueueWorkersModule` import it, so a process gets it from whichever of them it loads.
 */
@Global()
@Module({
  providers: [{ provide: ERROR_REPORTER_OPTIONS, useValue: DEFAULT_OPTIONS }, ErrorReporter],
  exports: [ErrorReporter],
})
export class ObservabilityModule {}
