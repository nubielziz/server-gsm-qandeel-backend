// Environment schema and loader (decision 013): every variable in one zod schema, parsed once, frozen.
// Production requires the secrets; development and test get safe local defaults that match compose.yaml.
import net from 'node:net';
import { z } from 'zod';

/**
 * The three runtime modes; the mode decides which variables are required and which defaults apply.
 *
 * Why: the mode decides which variables are required and which local defaults apply (decision 013).
 */
export type NodeEnv = 'development' | 'test' | 'production';

/**
 * pino level names accepted by `LOG_LEVEL`.
 *
 * Why: an invalid `LOG_LEVEL` must stop the deploy instead of silently logging nothing (decision 013).
 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/**
 * How the API serves the reference docs (decision 017): everyone, staff with `system:read`, or nobody.
 *
 * Why: the internal API reference lists every route, so production defaults to staff only and it can be switched off
 * (decision 017).
 */
export type ReferenceDocsMode = 'open' | 'staff' | 'off';

/**
 * The exchange-rate drivers `FX_PROVIDER` can name: `openexchangerates` (USD base, `latest.json`) or `manual`
 * (no provider; rates are edited by hand).
 *
 * Why: `POST /admin/currencies/refresh-fx` needs a named driver; `manual` makes it answer 502 FX_PROVIDER_DOWN
 * (RESOLUTIONS money-9).
 */
export type FxProviderName = 'openexchangerates' | 'manual';

/**
 * Which proxies may set `X-Forwarded-*`: `false` (none), a hop count (the last N hops) or a list of
 * IP/CIDR entries and named ranges (`loopback`, `linklocal`, `uniquelocal`).
 *
 * Why: the client IP feeds IP rules and rate limits (decision 018); trusting the wrong proxies would let a client forge
 * it.
 */
export type TrustProxy = false | number | readonly string[];

/**
 * The typed, frozen application configuration.
 *
 * Why: decision 013 keeps every setting in one validated object, so a bad setting stops the process at deploy
 * time and no other file reads `process.env`.
 */
export interface AppConfig {
  readonly env: NodeEnv;
  readonly isProduction: boolean;
  readonly http: {
    readonly host: string;
    readonly port: number;
    /** Proxies trusted for `X-Forwarded-*` (client IP, protocol). */
    readonly trustProxy: TrustProxy;
    readonly bodyLimitBytes: number;
    /** Exact origins allowed by CORS (scheme + host + optional port, no path). Empty = no cross-origin access. */
    readonly corsOrigins: readonly string[];
    /** Base of the problem+json `type` URI, without a trailing slash (decision 028). */
    readonly errorsBaseUrl: string;
    /** Base URL of the merchant portal, without a trailing slash; links in invitation emails are built from it. */
    readonly portalBaseUrl: string;
    /** Base URL of the storefront, without a trailing slash; the sign-in and password links of customers are built from it. */
    readonly storeBaseUrl: string;
    /** Lower-case name of the country header a trusted proxy sets (e.g. `cf-ipcountry`); unset = not used. */
    readonly geoipCountryHeader: string | undefined;
    readonly referenceDocs: ReferenceDocsMode;
  };
  /** Exchange-rate provider used by `POST /admin/currencies/refresh-fx` (RESOLUTIONS money-9). */
  readonly fx: {
    readonly provider: FxProviderName;
    /** Secret of the provider account; unset with `openexchangerates` means "not configured". */
    readonly apiKey: string | undefined;
    /** Explicit timeout of the provider call in milliseconds (decision 023). */
    readonly timeoutMs: number;
  };
  /** Email delivery (decision 033): SMTP through nodemailer; under `NODE_ENV=test` the app never opens a connection to it. */
  readonly mail: {
    /** `smtp://` or `smtps://` URL with credentials (secret). Development: the Mailpit of compose.yaml. */
    readonly smtpUrl: string;
    /** The sender of every mail: an address, or `Name <address>`. */
    readonly from: string;
  };
  /** Telegram Bot API (decision 033). Every value is optional: without a token, Telegram sends fail with a clear reason. */
  readonly telegram: {
    /** Secret token of the bot; unset means "Telegram is not configured". */
    readonly botToken: string | undefined;
    /** The bot's username without `@`, for the link `https://t.me/<username>?start=<token>`. */
    readonly botUsername: string | undefined;
    /** Secret of `POST /webhooks/telegram/:secret` (path segment and `X-Telegram-Bot-Api-Secret-Token` header); unset refuses every call. */
    readonly webhookSecret: string | undefined;
  };
  /**
   * Where the messages of alerts go (feature 12b): the ops mailbox(es) and the ops Telegram chat. Both are optional: a channel with no recipient
   * is recorded as a failed notification with a clear reason instead of stopping the boot.
   */
  readonly alerts: {
    /** Addresses that receive the email of an alert (one message to all of them); empty = none configured. */
    readonly emailTo: readonly string[];
    /** The Telegram chat that receives the Telegram message of an alert; unset = none configured. */
    readonly telegramChatId: string | undefined;
  };
  readonly log: { readonly level: LogLevel };
  readonly database: { readonly url: string; readonly testUrl: string; readonly poolMax: number };
  readonly redis: { readonly queueUrl: string; readonly cacheUrl: string; readonly bullPrefix: string };
  readonly s3: {
    /** Unset means the AWS default endpoint for the region. */
    readonly endpoint: string | undefined;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly forcePathStyle: boolean;
  };
  readonly security: {
    readonly csrfSecret: string;
    readonly csrfCookieDomain: string | undefined;
    readonly cookieSecure: boolean;
    readonly tokenPepper: string;
    /** AES-256-GCM keyring (decision 019): key id to 32 raw bytes. */
    readonly encryptionKeys: Readonly<Record<string, Buffer>>;
    readonly encryptionActiveKid: string;
    /** argon2id cost of new password hashes (decision 007); each stored hash carries the parameters it was made with. */
    readonly argon2: { readonly memoryKib: number; readonly timeCost: number; readonly parallelism: number };
  };
  /** The anti-bot check of the public storefront writes (decision 034). */
  readonly turnstile: {
    /** Cloudflare Turnstile secret; unset outside production means the dummy verifier (no network). */
    readonly secretKey: string | undefined;
    /** Host names a verified token may have been issued for; empty = any. */
    readonly hostnames: readonly string[];
  };
  readonly observability: {
    /** When set, `/metrics` requires `Authorization: Bearer <token>`; when unset only private networks may read it. */
    readonly metricsToken: string | undefined;
    readonly workerMetricsPort: number;
    readonly prometheusUrl: string | undefined;
    readonly sentryDsn: string | undefined;
  };
  /** The running build, shown on the System health Overview (`APP_VERSION`, `GIT_SHA`, `DEPLOYED_AT`). */
  readonly build: {
    readonly version: string;
    /** The first 7 characters of the commit; `unknown` when the deploy did not set it. */
    readonly commit: string;
    /** When this build went live (ISO time), or `undefined` when the deploy did not say. */
    readonly deployedAt: string | undefined;
  };
}

/**
 * One problem found while reading the environment, named by its variable.
 *
 * Why: an operator must see every configuration problem in one run, each named by its variable (decision 013).
 */
export interface ConfigIssue {
  readonly variable: string;
  readonly message: string;
}

/**
 * Thrown when the environment is invalid; its message lists every problem so one deploy attempt fixes them all.
 *
 * Why: decision 013 wants a readable list and no partial start.
 */
export class ConfigError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i.variable}: ${i.message}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const NODE_ENVS = ['development', 'test', 'production'] as const;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const NAMED_PROXY_RANGES = ['loopback', 'linklocal', 'uniquelocal'] as const;
const FX_PROVIDERS = ['openexchangerates', 'manual'] as const satisfies readonly FxProviderName[];
const MAX_TRUST_PROXY_HOPS = 10;

/**
 * Local-only values used outside production; production rejects them so a copied `.env` cannot reach it.
 *
 * Why: a fresh checkout runs after `docker compose up -d` with no `.env`; production refuses these values.
 */
export const DEV_DEFAULTS = {
  databaseUrl: 'postgres://gsm:gsm@localhost:5432/gsm',
  databaseUrlTest: 'postgres://gsm:gsm@localhost:5432/gsm_test',
  redisQueueUrl: 'redis://localhost:6379/0',
  redisCacheUrl: 'redis://localhost:6380/0',
  // NODE_ENV=test never touches the development data: Redis database 1 on both roles and the test bucket.
  redisQueueUrlTest: 'redis://localhost:6379/1',
  redisCacheUrlTest: 'redis://localhost:6380/1',
  s3Endpoint: 'http://localhost:9000',
  s3Bucket: 'gsm-files',
  s3BucketTest: 'gsm-files-test',
  s3AccessKeyId: 'gsm-minio',
  s3SecretAccessKey: 'gsm-minio-secret',
  csrfSecret: 'dev-only-csrf-secret-do-not-use-in-production-0123456789',
  tokenPepper: 'dev-only-token-pepper-do-not-use-in-production-0123456789',
  encryptionKid: 'dev1',
  encryptionKey: Buffer.alloc(32, 'gsm-dev-key').toString('base64'),
  errorsBaseUrl: 'http://localhost:3000/errors',
  portalBaseUrl: 'http://localhost:5174',
  storeBaseUrl: 'http://localhost:5175',
  // The console on 5173 and the merchant portal on 5174 (the origin of `portalBaseUrl`); development only: production and tests default to none.
  corsOrigins: 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174',
  // The Mailpit of compose.yaml (decision 033): SMTP on 1025, a web UI on 8025 with every message.
  mailSmtpUrl: 'smtp://localhost:1025',
  mailFrom: 'GSM <noreply@gsm.local>',
} as const;

const url = (protocol: RegExp) => z.url({ protocol });
const httpUrl = url(/^https?$/);
const postgresUrl = url(/^postgres(ql)?$/);
const redisUrl = url(/^rediss?$/);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/** Shape of the raw variables: format checks only; defaults, production rules and joins happen afterwards. */
const rawSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).optional(),
  PORT: int(1, 65535).optional(),
  HOST: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  TRUST_PROXY: z.string().optional(),
  BODY_LIMIT_BYTES: int(1024, 100 * 1024 * 1024).optional(),
  CORS_ORIGINS: z.string().optional(),
  ERRORS_BASE_URL: httpUrl.optional(),
  PORTAL_BASE_URL: httpUrl.optional(),
  STORE_BASE_URL: httpUrl.optional(),
  GEOIP_COUNTRY_HEADER: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/, 'use a header name: letters, digits or "-" (1-64 characters)')
    .optional(),
  FX_PROVIDER: z.enum(FX_PROVIDERS).optional(),
  FX_API_KEY: z.string().min(1).optional(),
  FX_TIMEOUT_MS: int(100, 60_000).optional(),
  MAIL_SMTP_URL: url(/^smtps?$/).optional(),
  MAIL_FROM: z
    .string()
    .regex(/^(?:[^<>@\r\n]+<[^<>@\s]+@[^<>@\s]+>|[^<>@\s]+@[^<>@\s]+)$/, 'use an address or "Name <address>"')
    .optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(10).optional(),
  TELEGRAM_BOT_USERNAME: z
    .string()
    .regex(/^[A-Za-z0-9_]{5,32}$/, 'use the bot username without "@": 5-32 letters, digits or "_"')
    .optional(),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,256}$/, 'use 16-256 letters, digits, "_" or "-" (Telegram allows nothing else)')
    .optional(),
  ALERTS_EMAIL_TO: z.string().optional(),
  ALERTS_TELEGRAM_CHAT_ID: z
    .string()
    .regex(
      /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/,
      'use a chat id (digits, "-" first for a group) or @channelname',
    )
    .optional(),
  DATABASE_URL: postgresUrl.optional(),
  DATABASE_URL_TEST: postgresUrl.optional(),
  DATABASE_POOL_MAX: int(1, 200).optional(),
  REDIS_QUEUE_URL: redisUrl.optional(),
  REDIS_CACHE_URL: redisUrl.optional(),
  REDIS_QUEUE_URL_TEST: redisUrl.optional(),
  REDIS_CACHE_URL_TEST: redisUrl.optional(),
  BULL_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9:_-]{1,64}$/, 'use letters, digits, ":", "_" or "-" (1-64 characters)')
    .optional(),
  S3_ENDPOINT: httpUrl.optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(3).optional(),
  S3_BUCKET_TEST: z.string().min(3).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z.stringbool().optional(),
  CSRF_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  CSRF_COOKIE_DOMAIN: z.string().min(1).optional(),
  COOKIE_SECURE: z.stringbool().optional(),
  TOKEN_PEPPER: z.string().min(32, 'must be at least 32 characters').optional(),
  ENCRYPTION_KEYS: z.string().optional(),
  ENCRYPTION_ACTIVE_KID: z.string().optional(),
  ARGON2_MEMORY_KIB: int(8, 1_048_576).optional(),
  ARGON2_TIME_COST: int(1, 20).optional(),
  ARGON2_PARALLELISM: int(1, 16).optional(),
  METRICS_TOKEN: z.string().min(16, 'must be at least 16 characters').optional(),
  WORKER_METRICS_PORT: int(1, 65535).optional(),
  PROMETHEUS_URL: httpUrl.optional(),
  SENTRY_DSN: httpUrl.optional(),
  APP_VERSION: z.string().trim().min(1).max(40).optional(),
  GIT_SHA: z.string().trim().min(1).max(64).optional(),
  DEPLOYED_AT: z.iso.datetime({ offset: true }).optional(),
  REFERENCE_DOCS: z.enum(['open', 'staff', 'off']).optional(),
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
  TURNSTILE_HOSTNAMES: z.string().optional(),
});

type RawEnv = z.output<typeof rawSchema>;
/**
 * Every environment variable the application reads (also the list `.env.example` must document).
 *
 * Why: a test keeps `.env.example` complete.
 */
export const ENV_VARIABLES: readonly string[] = Object.keys(rawSchema.shape);
const KNOWN_VARIABLES = ENV_VARIABLES;

type TrustProxyResult =
  { readonly ok: true; readonly value: TrustProxy } | { readonly ok: false; readonly message: string };

/** True for `a.b.c.d/n` or `ipv6/n` with a prefix inside the family's range, or a bare address. */
function isIpOrCidr(entry: string): boolean {
  const [address, prefix, extra] = entry.split('/');
  if (extra !== undefined || address === undefined) return false;
  const family = net.isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * Parses `TRUST_PROXY`: empty/`false`/`0` (none), a hop count (1-10) or a comma list of IP/CIDR entries.
 *
 * Why: a wrong proxy trust lets any client forge its IP, which would defeat IP rules and rate limits (decision 018).
 * "Trust everything" (`true`, `/0`) is refused on purpose.
 *
 * @param value raw variable text
 * @returns the parsed value, or the reason it is invalid
 */
export function parseTrustProxy(value: string | undefined): TrustProxyResult {
  const text = value?.trim() ?? '';
  if (text === '' || text === 'false' || text === '0') return { ok: true, value: false };
  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    return hops <= MAX_TRUST_PROXY_HOPS
      ? { ok: true, value: hops }
      : { ok: false, message: `a hop count must be between 1 and ${MAX_TRUST_PROXY_HOPS}` };
  }
  const entries = text.split(',').map((part) => part.trim());
  for (const entry of entries) {
    if ((NAMED_PROXY_RANGES as readonly string[]).includes(entry)) continue;
    if (!isIpOrCidr(entry)) {
      return {
        ok: false,
        message: `"${entry}" is not a hop count, an IP, a CIDR range or one of ${NAMED_PROXY_RANGES.join(', ')}`,
      };
    }
    if (entry.endsWith('/0')) return { ok: false, message: `"${entry}" would trust every address` };
  }
  return { ok: true, value: [...new Set(entries)] };
}

/**
 * Parses `CORS_ORIGINS`: a comma list of exact origins (`https://console.example.com`, `http://localhost:5173`).
 *
 * Why: credentials are allowed (ALIGNMENT § 6), so wildcards, paths and trailing slashes are refused.
 *
 * @param value raw variable text
 * @returns the unique origins, or the reason one is invalid
 */
export function parseCorsOrigins(
  value: string,
): { ok: true; value: readonly string[] } | { ok: false; message: string } {
  const origins: string[] = [];
  for (const part of value.split(',')) {
    const origin = part.trim();
    if (origin === '') continue;
    let parsed: URL | undefined;
    try {
      parsed = new URL(origin);
    } catch {
      parsed = undefined;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      return { ok: false, message: `"${origin}" is not an http(s) origin` };
    }
    if (parsed.origin !== origin) {
      return { ok: false, message: `"${origin}" must be written as an exact origin: ${parsed.origin}` };
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return { ok: true, value: origins };
}

/**
 * Parses `TURNSTILE_HOSTNAMES`: a comma list of host names (`shop.example.com`).
 *
 * Why: decision 034: a token is only accepted when Cloudflare says it was issued for one of our storefront hosts; a
 * scheme, a port or a path in an entry is a typo that would silently never match, so it stops the deploy.
 *
 * @param value raw variable text
 * @returns the unique lower-case host names, or the reason one is invalid
 */
export function parseTurnstileHostnames(
  value: string,
): { ok: true; value: readonly string[] } | { ok: false; message: string } {
  const hosts: string[] = [];
  for (const part of value.split(',')) {
    const host = part.trim().toLowerCase();
    if (host === '') continue;
    if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host)) {
      return { ok: false, message: `"${host}" is not a host name (no scheme, port or path)` };
    }
    if (!hosts.includes(host)) hosts.push(host);
  }
  return { ok: true, value: hosts };
}

/**
 * Parses `ALERTS_EMAIL_TO`: a comma list of email addresses (`ops@example.com`).
 *
 * Why: feature 12b sends one email per alert to these addresses; an entry with a name, a space or no domain would never be delivered, so it stops
 * the deploy instead of failing in the middle of the night.
 *
 * @param value raw variable text
 * @returns the unique addresses (compared without regard to letter case, written as given), or the reason one is invalid
 */
export function parseAlertEmails(
  value: string,
): { ok: true; value: readonly string[] } | { ok: false; message: string } {
  const addresses: string[] = [];
  for (const part of value.split(',')) {
    const address = part.trim();
    if (address === '') continue;
    if (!/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(address)) {
      // The address itself is not repeated: the boot error is logged, and the variable may hold other people's addresses.
      return {
        ok: false,
        message: 'holds an entry that is not an email address (write plain addresses separated by commas)',
      };
    }
    if (!addresses.some((known) => known.toLowerCase() === address.toLowerCase())) addresses.push(address);
  }
  return { ok: true, value: addresses };
}

/**
 * Parses `ENCRYPTION_KEYS` (`kid:base64-32-bytes`, comma separated; decision 019).
 *
 * Why: decision 019: a malformed keyring must stop the deploy, not the first encryption.
 *
 * @param value raw variable text
 * @returns the keyring (key id to 32 bytes), or the reason it is invalid
 */
export function parseEncryptionKeys(
  value: string,
): { ok: true; value: Record<string, Buffer> } | { ok: false; message: string } {
  const keys: Record<string, Buffer> = {};
  for (const part of value.split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    const colon = entry.indexOf(':');
    const kid = colon < 0 ? '' : entry.slice(0, colon);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) {
      return {
        ok: false,
        message: 'each key must look like "<kid>:<base64 key>" with a kid of 1-32 letters, digits, "_" or "-"',
      };
    }
    const material = entry.slice(colon + 1);
    const key = /^[A-Za-z0-9+/]+={0,2}$/.test(material) ? Buffer.from(material, 'base64') : Buffer.alloc(0);
    if (key.length !== 32) return { ok: false, message: `key "${kid}" must be 32 bytes encoded as base64` };
    if (Object.hasOwn(keys, kid)) return { ok: false, message: `key id "${kid}" appears twice` };
    keys[kid] = key;
  }
  if (Object.keys(keys).length === 0) return { ok: false, message: 'at least one key is required' };
  return { ok: true, value: keys };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value) && !Buffer.isBuffer(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Joins the raw variables into the typed config: defaults per mode, production rules, cross-field checks.
 * Problems are reported through `fail` (never thrown) so that one run lists every problem.
 */
function resolveConfig(raw: RawEnv, fail: (variable: string, message: string) => void): AppConfig {
  const env: NodeEnv = raw.NODE_ENV ?? 'development';
  const production = env === 'production';
  const testing = env === 'test';
  // A value that has a local default outside production and must be given in production.
  const withDefault = <T>(variable: string, value: T | undefined, devDefault: T): T => {
    if (value !== undefined) return value;
    if (production) {
      fail(variable, 'is required in production');
      return devDefault;
    }
    return devDefault;
  };
  // A value that was given must not be the development default (a copied `.env` must not reach production).
  const noDevValue = (variable: string, given: string | undefined, devValue: string) => {
    if (production && given === devValue) fail(variable, 'must not use the development default in production');
  };

  const trust = parseTrustProxy(raw.TRUST_PROXY);
  if (!trust.ok) fail('TRUST_PROXY', trust.message);
  const cors = parseCorsOrigins(raw.CORS_ORIGINS ?? (production || env === 'test' ? '' : DEV_DEFAULTS.corsOrigins));
  if (!cors.ok) fail('CORS_ORIGINS', cors.message);

  const keysText = withDefault(
    'ENCRYPTION_KEYS',
    raw.ENCRYPTION_KEYS,
    `${DEV_DEFAULTS.encryptionKid}:${DEV_DEFAULTS.encryptionKey}`,
  );
  const keyring = parseEncryptionKeys(keysText);
  if (!keyring.ok) fail('ENCRYPTION_KEYS', keyring.message);
  const encryptionKeys = keyring.ok ? keyring.value : {};
  const activeKid = withDefault('ENCRYPTION_ACTIVE_KID', raw.ENCRYPTION_ACTIVE_KID, DEV_DEFAULTS.encryptionKid);
  if (keyring.ok && !Object.hasOwn(encryptionKeys, activeKid)) {
    fail('ENCRYPTION_ACTIVE_KID', `"${activeKid}" is not one of the key ids in ENCRYPTION_KEYS`);
  }
  if (production && raw.ENCRYPTION_KEYS?.includes(DEV_DEFAULTS.encryptionKey)) {
    fail('ENCRYPTION_KEYS', 'must not use the development key in production');
  }

  const csrfSecret = withDefault('CSRF_SECRET', raw.CSRF_SECRET, DEV_DEFAULTS.csrfSecret);
  noDevValue('CSRF_SECRET', raw.CSRF_SECRET, DEV_DEFAULTS.csrfSecret);
  const tokenPepper = withDefault('TOKEN_PEPPER', raw.TOKEN_PEPPER, DEV_DEFAULTS.tokenPepper);
  noDevValue('TOKEN_PEPPER', raw.TOKEN_PEPPER, DEV_DEFAULTS.tokenPepper);
  const cookieSecure = raw.COOKIE_SECURE ?? production;
  if (production && !cookieSecure) fail('COOKIE_SECURE', 'must be true in production (session cookies are Secure)');
  // Behind a proxy that adds no forwarding header the public internet looks internal, so production always needs the
  // metrics token (decision 015); Prometheus scrapes with it.
  if (production && raw.METRICS_TOKEN === undefined) fail('METRICS_TOKEN', 'is required in production');

  // OWASP baseline for argon2id (decision 007); `bun run bench:argon2` helps pick values for the target host.
  const argon2 = {
    memoryKib: raw.ARGON2_MEMORY_KIB ?? 19_456,
    timeCost: raw.ARGON2_TIME_COST ?? 2,
    parallelism: raw.ARGON2_PARALLELISM ?? 1,
  };
  if (argon2.memoryKib < 8 * argon2.parallelism) {
    fail('ARGON2_MEMORY_KIB', 'must be at least 8 times ARGON2_PARALLELISM (argon2 needs 8 KiB per lane)');
  }

  const errorsBaseUrl = withDefault('ERRORS_BASE_URL', raw.ERRORS_BASE_URL, DEV_DEFAULTS.errorsBaseUrl).replace(
    /\/+$/,
    '',
  );
  // The merchant invite link is `<PORTAL_BASE_URL>/set-password?token=...` (RESOLUTIONS identity-platform-2).
  const portalBaseUrl = withDefault('PORTAL_BASE_URL', raw.PORTAL_BASE_URL, DEV_DEFAULTS.portalBaseUrl).replace(
    /\/+$/,
    '',
  );
  // The customer links are `<STORE_BASE_URL>/sign-in?token=...` and `/set-password?token=...` (feature 14b).
  const storeBaseUrl = withDefault('STORE_BASE_URL', raw.STORE_BASE_URL, DEV_DEFAULTS.storeBaseUrl).replace(/\/+$/, '');
  const s3Endpoint = raw.S3_ENDPOINT ?? (production ? undefined : DEV_DEFAULTS.s3Endpoint);
  // Decision 034: production never runs the dummy verifier, which accepts a public test token.
  if (production && raw.TURNSTILE_SECRET_KEY === undefined) fail('TURNSTILE_SECRET_KEY', 'is required in production');
  const turnstileHosts = parseTurnstileHostnames(raw.TURNSTILE_HOSTNAMES ?? '');
  if (!turnstileHosts.ok) fail('TURNSTILE_HOSTNAMES', turnstileHosts.message);
  const alertEmails = parseAlertEmails(raw.ALERTS_EMAIL_TO ?? '');
  if (!alertEmails.ok) fail('ALERTS_EMAIL_TO', alertEmails.message);

  return {
    env,
    isProduction: production,
    http: {
      host: raw.HOST ?? '0.0.0.0',
      port: raw.PORT ?? 3000,
      trustProxy: trust.ok ? trust.value : false,
      bodyLimitBytes: raw.BODY_LIMIT_BYTES ?? 1024 * 1024,
      corsOrigins: cors.ok ? cors.value : [],
      errorsBaseUrl,
      portalBaseUrl,
      storeBaseUrl,
      geoipCountryHeader: raw.GEOIP_COUNTRY_HEADER?.toLowerCase(),
      referenceDocs: raw.REFERENCE_DOCS ?? (production ? 'staff' : 'open'),
    },
    // The key stays optional: without it the refresh answers 502 FX_PROVIDER_DOWN instead of stopping the boot.
    fx: {
      provider: raw.FX_PROVIDER ?? (production ? 'openexchangerates' : 'manual'),
      apiKey: raw.FX_API_KEY,
      timeoutMs: raw.FX_TIMEOUT_MS ?? 5000,
    },
    // Production sends real mail, so both settings must be given there (decision 033); elsewhere Mailpit is the default.
    mail: {
      smtpUrl: withDefault('MAIL_SMTP_URL', raw.MAIL_SMTP_URL, DEV_DEFAULTS.mailSmtpUrl),
      from: withDefault('MAIL_FROM', raw.MAIL_FROM, DEV_DEFAULTS.mailFrom),
    },
    // Telegram is optional everywhere: a missing token fails the send with a reason instead of stopping the boot.
    telegram: {
      botToken: raw.TELEGRAM_BOT_TOKEN,
      botUsername: raw.TELEGRAM_BOT_USERNAME,
      webhookSecret: raw.TELEGRAM_WEBHOOK_SECRET,
    },
    // The ops recipients of alert messages are optional everywhere: without them the message is recorded as failed, with the reason.
    alerts: {
      emailTo: alertEmails.ok ? alertEmails.value : [],
      telegramChatId: raw.ALERTS_TELEGRAM_CHAT_ID,
    },
    log: { level: raw.LOG_LEVEL ?? (production ? 'info' : env === 'test' ? 'warn' : 'debug') },
    database: {
      url: withDefault('DATABASE_URL', raw.DATABASE_URL, DEV_DEFAULTS.databaseUrl),
      testUrl: raw.DATABASE_URL_TEST ?? DEV_DEFAULTS.databaseUrlTest,
      poolMax: raw.DATABASE_POOL_MAX ?? 10,
    },
    // Under NODE_ENV=test the normal variables are ignored on purpose: a test run can never reach the development
    // Redis data or bucket, even when both are configured (same guarantee as DATABASE_URL_TEST, decision 014).
    redis: {
      queueUrl: testing
        ? (raw.REDIS_QUEUE_URL_TEST ?? DEV_DEFAULTS.redisQueueUrlTest)
        : withDefault('REDIS_QUEUE_URL', raw.REDIS_QUEUE_URL, DEV_DEFAULTS.redisQueueUrl),
      cacheUrl: testing
        ? (raw.REDIS_CACHE_URL_TEST ?? DEV_DEFAULTS.redisCacheUrlTest)
        : withDefault('REDIS_CACHE_URL', raw.REDIS_CACHE_URL, DEV_DEFAULTS.redisCacheUrl),
      bullPrefix: raw.BULL_PREFIX ?? `gsm:${env}:bull`,
    },
    s3: {
      endpoint: s3Endpoint,
      region: raw.S3_REGION ?? 'us-east-1',
      bucket: testing
        ? (raw.S3_BUCKET_TEST ?? DEV_DEFAULTS.s3BucketTest)
        : withDefault('S3_BUCKET', raw.S3_BUCKET, DEV_DEFAULTS.s3Bucket),
      accessKeyId: withDefault('S3_ACCESS_KEY_ID', raw.S3_ACCESS_KEY_ID, DEV_DEFAULTS.s3AccessKeyId),
      secretAccessKey: withDefault('S3_SECRET_ACCESS_KEY', raw.S3_SECRET_ACCESS_KEY, DEV_DEFAULTS.s3SecretAccessKey),
      forcePathStyle: raw.S3_FORCE_PATH_STYLE ?? !production,
    },
    security: {
      csrfSecret,
      csrfCookieDomain: raw.CSRF_COOKIE_DOMAIN,
      cookieSecure,
      tokenPepper,
      encryptionKeys,
      encryptionActiveKid: activeKid,
      argon2,
    },
    turnstile: { secretKey: raw.TURNSTILE_SECRET_KEY, hostnames: turnstileHosts.ok ? turnstileHosts.value : [] },
    observability: {
      metricsToken: raw.METRICS_TOKEN,
      workerMetricsPort: raw.WORKER_METRICS_PORT ?? 9464,
      prometheusUrl: raw.PROMETHEUS_URL,
      sentryDsn: raw.SENTRY_DSN,
    },
    build: {
      version: raw.APP_VERSION ?? '0.0.0-dev',
      commit: (raw.GIT_SHA ?? 'unknown').slice(0, 7),
      deployedAt: raw.DEPLOYED_AT,
    },
  };
}

/** Variables set to an empty string behave as unset (a bare `FOO=` line in a `.env` file). */
function normalize(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of KNOWN_VARIABLES) {
    const value = env[name]?.trim();
    if (value) picked[name] = value;
  }
  return picked;
}

/** The fields that are valid on their own, so the second stage can still check the rest of the environment. */
function salvage(env: Record<string, string>): RawEnv {
  const kept: Record<string, unknown> = {};
  for (const name of KNOWN_VARIABLES) {
    const field = (rawSchema.shape as Record<string, z.ZodType>)[name];
    const result = field?.safeParse(env[name]);
    if (result?.success && result.data !== undefined) kept[name] = result.data;
  }
  return kept;
}

/**
 * Validates an environment record and returns the frozen typed config.
 *
 * Why: the single schema of decision 013; pure so tests can try any environment without touching `process.env`.
 * Format problems and missing/inconsistent settings are reported together, once per variable.
 *
 * @param env variables to read (unknown names are ignored)
 * @returns the deep-frozen configuration
 * @throws {ConfigError} listing every invalid or missing variable
 */
export function parseEnv(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const normalized = normalize(env);
  const issues: ConfigIssue[] = [];
  const reported = new Set<string>();
  const report = (variable: string, message: string) => {
    // Messages never echo the offending value, so a malformed secret does not end up in the deploy log.
    if (reported.has(variable)) return;
    reported.add(variable);
    issues.push({ variable, message });
  };

  const parsed = rawSchema.safeParse(normalized);
  if (!parsed.success)
    for (const issue of parsed.error.issues) report(String(issue.path[0] ?? 'environment'), issue.message);
  const config = resolveConfig(parsed.success ? parsed.data : salvage(normalized), report);
  if (issues.length > 0) throw new ConfigError(issues);
  return deepFreeze(config);
}

let cached: AppConfig | undefined;

/**
 * Reads `process.env` once and returns the same frozen config on every later call.
 *
 * Why: the API, the worker and every provider must see one configuration; this is the only place that touches
 * `process.env` (decision 013).
 *
 * @returns the process configuration
 * @throws {ConfigError} when the environment is invalid
 */
export function loadConfig(): AppConfig {
  cached ??= parseEnv(process.env);
  return cached;
}

/**
 * Entry-point helper: loads the config or prints the problem list and exits with code 1.
 *
 * Why: a process with a bad setting must not start (decision 013); the list tells the operator what to fix.
 *
 * @returns the process configuration
 */
export function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    // eslint-disable-next-line no-console -- the logger needs a valid config, so this is the last message before exit.
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  }
}

/** Hides credentials in a URL (`postgres://user:pass@host/db` becomes `postgres://user:***@host/db`). */
function redactUrl(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '[invalid url]';
  }
}

const flag = (value: unknown) => (value ? '[set]' : '[unset]');

/**
 * Builds the redacted summary the boot log prints: no secrets, no passwords, no key material.
 *
 * Why: operators need to see which settings the process runs with (decision 013) without leaking credentials.
 *
 * @param config the process configuration
 * @returns plain JSON-safe data
 */
export function summarizeConfig(config: AppConfig): Record<string, unknown> {
  return {
    env: config.env,
    http: {
      host: config.http.host,
      port: config.http.port,
      trustProxy: config.http.trustProxy,
      bodyLimitBytes: config.http.bodyLimitBytes,
      corsOrigins: config.http.corsOrigins,
      errorsBaseUrl: config.http.errorsBaseUrl,
      portalBaseUrl: config.http.portalBaseUrl,
      storeBaseUrl: config.http.storeBaseUrl,
      geoipCountryHeader: config.http.geoipCountryHeader,
      referenceDocs: config.http.referenceDocs,
    },
    fx: { provider: config.fx.provider, apiKey: flag(config.fx.apiKey), timeoutMs: config.fx.timeoutMs },
    mail: { smtpUrl: redactUrl(config.mail.smtpUrl), from: config.mail.from },
    telegram: {
      botToken: flag(config.telegram.botToken),
      botUsername: config.telegram.botUsername,
      webhookSecret: flag(config.telegram.webhookSecret),
    },
    // Addresses and the chat id are personal data: the summary says only how many and whether they are set.
    alerts: { emailRecipients: config.alerts.emailTo.length, telegramChat: flag(config.alerts.telegramChatId) },
    logLevel: config.log.level,
    database: { url: redactUrl(config.database.url), poolMax: config.database.poolMax },
    redis: {
      queueUrl: redactUrl(config.redis.queueUrl),
      cacheUrl: redactUrl(config.redis.cacheUrl),
      bullPrefix: config.redis.bullPrefix,
    },
    s3: {
      endpoint: redactUrl(config.s3.endpoint),
      region: config.s3.region,
      bucket: config.s3.bucket,
      forcePathStyle: config.s3.forcePathStyle,
      accessKeyId: flag(config.s3.accessKeyId),
      secretAccessKey: flag(config.s3.secretAccessKey),
    },
    security: {
      csrfSecret: flag(config.security.csrfSecret),
      csrfCookieDomain: config.security.csrfCookieDomain,
      cookieSecure: config.security.cookieSecure,
      tokenPepper: flag(config.security.tokenPepper),
      encryptionKeyIds: Object.keys(config.security.encryptionKeys),
      encryptionActiveKid: config.security.encryptionActiveKid,
      argon2: config.security.argon2,
    },
    turnstile: { secretKey: flag(config.turnstile.secretKey), hostnames: config.turnstile.hostnames },
    observability: {
      metricsToken: flag(config.observability.metricsToken),
      workerMetricsPort: config.observability.workerMetricsPort,
      prometheusUrl: redactUrl(config.observability.prometheusUrl),
      sentryDsn: flag(config.observability.sentryDsn),
    },
    build: config.build,
  };
}
