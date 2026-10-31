// Public surface of src/infra/logging: the module, the pino options, masking helpers and the access log hook.
export { registerAccessLog } from './access-log';
export { LOG_DESTINATION, LoggingModule } from './logging.module';
export { maskEmail, maskImei, maskPhone } from './mask';
export { buildPinoOptions, chooseDestination, requestIdMixin } from './pino-options';
export type { ServiceName } from './pino-options';
export { PII_SERIALIZERS, REDACT_CENSOR, REDACT_PATHS } from './redaction';
