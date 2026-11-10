// Public surface of src/infra/observability: the error reporter, its module and the scrubbing rules.
export { ERROR_REPORTER_OPTIONS, ErrorReporter } from './error-reporter';
export type { ErrorContext, ErrorReporterOptions, SentryTransportFactory } from './error-reporter';
export { ObservabilityModule } from './observability.module';
export { scrubEvent, scrubText } from './scrub';
export type { ScrubbableEvent } from './scrub';
