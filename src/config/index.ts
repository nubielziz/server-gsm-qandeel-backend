// Public surface of src/config: the typed config, its loader and the Nest module (decision 013).
export { ConfigModule, APP_CONFIG } from './config.module';
export {
  ARGON2_FLOOR_REFUSED,
  ConfigError,
  DEV_DEFAULTS,
  ENV_VARIABLES,
  NODE_ENV_REMOTE_REFUSED,
  PLACEHOLDER_REFUSED,
  TRUST_PROXY_RANGE_WARNING,
  WEAK_PASSWORD_REFUSED,
  argon2MeetsFloor,
  databaseIsLocal,
  isLocalHost,
  isStackHost,
  loadConfig,
  loadConfigOrExit,
  parseCorsOrigins,
  parseEncryptionKeys,
  parseEnv,
  parseTrustProxy,
  parseTurnstileHostnames,
  searchPrefixOf,
  summarizeConfig,
  trustProxyIsRange,
} from './env';
export type { AppConfig, ConfigIssue, LogLevel, NodeEnv, ReferenceDocsMode, TrustProxy } from './env';
