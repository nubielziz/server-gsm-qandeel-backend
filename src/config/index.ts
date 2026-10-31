// Public surface of src/config: the typed config, its loader and the Nest module (decision 013).
export { ConfigModule, APP_CONFIG } from './config.module';
export {
  ConfigError,
  DEV_DEFAULTS,
  ENV_VARIABLES,
  loadConfig,
  loadConfigOrExit,
  parseCorsOrigins,
  parseEncryptionKeys,
  parseEnv,
  parseTrustProxy,
  summarizeConfig,
} from './env';
export type { AppConfig, ConfigIssue, LogLevel, NodeEnv, ReferenceDocsMode, TrustProxy } from './env';
