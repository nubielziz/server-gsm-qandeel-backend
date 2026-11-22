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
    /**
     * Proxies trusted for `X-Forwarded-*` (client IP, protocol). Production requires it (decision 055): the exact addresses of the
     * proxies, or `false` for a stack without one; a range or a hop count gives a boot warning.
     */
    readonly trustProxy: TrustProxy;
    readonly bodyLimitBytes: number;
    /**
     * `HTTP_HEADERS_TIMEOUT_MS`: how long the headers of one request may take to arrive (default 20 000). A connection that sends half a
     * request line and stops is closed after this (decision 053).
     */
    readonly headersTimeoutMs: number;
    /**
     * `HTTP_REQUEST_TIMEOUT_MS`: how long a whole request, body included, may take (default 600 000); a 25 MiB upload finishes at about
     * 0.35 Mbit/s. A request whose body stalls is cut after this (decision 053). It bounds the request, not the response: a live stream
     * (its request ends with its headers) and a long download are not cut by it.
     */
    readonly requestTimeoutMs: number;
    /**
     * Exact browser origins of the admin console (`CONSOLE_ORIGINS`): CORS on `/admin` and `/reference` and the Origin checks of the
     * staff surface (decision 045). Empty = none.
     */
    readonly consoleOrigins: readonly string[];
    /**
     * Exact browser origins of the storefront and the merchant portal (`SHOP_ORIGINS`): CORS on `/client` and `/store/v1` and the Origin
     * checks of those surfaces (decision 045). Empty = none.
     */
    readonly shopOrigins: readonly string[];
    /** Base of the problem+json `type` URI, without a trailing slash (decision 028). */
    readonly errorsBaseUrl: string;
    /** Base URL of the merchant portal, without a trailing slash; links in invitation emails are built from it. */
    readonly portalBaseUrl: string;
    /** Base URL of the admin console, without a trailing slash; the staff invitation and reset links are built from it (feature 20). */
    readonly consoleBaseUrl: string;
    /** Base URL of the storefront, without a trailing slash; the sign-in and password links of customers are built from it. */
    readonly storeBaseUrl: string;
    /** Lower-case name of the country header a trusted proxy sets (e.g. `cf-ipcountry`); unset = not used. */
    readonly geoipCountryHeader: string | undefined;
    readonly referenceDocs: ReferenceDocsMode;
  };
  /** Exchange-rate provider used by `POST /admin/currencies/refresh-fx` (RESOLUTIONS money-9). */
  readonly fx: {
    readonly provider: FxProviderName;
    /** Secret of the provider account; unset with `openexchangerates` means "not configured" (refused in production, decision 049). */
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
    /** STARTTLS is required on an `smtp://` URL; `smtps://` is TLS from the start (decision 055). On in production, off elsewhere. */
    readonly requireTls: boolean;
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
  readonly database: {
    readonly url: string;
    readonly testUrl: string;
    /**
     * The owner role of the tables, for `db:migrate` and `setup` (decision 055); never set for the API and the worker in production.
     * Outside production unset means `DATABASE_URL`; ignored under `NODE_ENV=test`.
     */
    readonly ownerUrl: string | undefined;
    /**
     * `PGHOST`: the host the Postgres driver connects to when a database URL names none (decision 055). Only the locality rule reads it
     * (a URL without a host is local only when this is local too); the pool itself never receives it.
     */
    readonly driverHost: string | undefined;
    readonly poolMax: number;
    /**
     * Session limits of this process's pool (decision 055); 0 means no limit. Defaults 15 s, 5 s and 60 s; none under
     * NODE_ENV=test; the production compose gives the worker 300 s and 30 s.
     */
    readonly timeouts: {
      readonly statementMs: number;
      readonly lockMs: number;
      readonly idleInTransactionMs: number;
    };
  };
  readonly redis: { readonly queueUrl: string; readonly cacheUrl: string; readonly bullPrefix: string };
  readonly s3: {
    /** Unset means the AWS default endpoint for the region. */
    readonly endpoint: string | undefined;
    /** The address presigned links are signed for (decision 055): the one a browser reaches; unset means `endpoint`. */
    readonly publicEndpoint: string | undefined;
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
    /**
     * HMAC key of every hash stored for later matching (decision 054): the blocklist, the IMEI checks, inventory and open-order
     * duplicates, unsubscribe links, Idempotency-Key requests, webhook event ids and the shop's link tokens. Outside production
     * `TOKEN_PEPPER` when `LOOKUP_HASH_KEY` is unset; production requires it.
     */
    readonly lookupHashKey: string;
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
    /**
     * `TURNSTILE_MERCHANT_AUTH`: enforce the check on the public merchant sign-up, sign-in and forgot-password routes (feature 24A,
     * `turnstileRollout: 'merchant-auth'`). On by default in production (the shop sends the token on its merchant forms, decision 052),
     * off by default elsewhere; `false` switches it off. The storefront routes are always checked.
     */
    readonly merchantAuth: boolean;
  };
  /**
   * The public storefront search on Typesense (feature 29, decision 038). Postgres stays the truth: with search off, or with the
   * engine down, every search is the Postgres fallback.
   */
  readonly search: {
    /** `SEARCH_ENABLED` (`SEARCH_ENABLED_TEST` under test, default false there): off makes every search the fallback and the sync jobs complete without calls. */
    readonly enabled: boolean;
    /** `TYPESENSE_URL` (`TYPESENSE_URL_TEST` under test): the node's base URL, without a trailing slash. */
    readonly url: string;
    /** `TYPESENSE_INDEXER_KEY`: the worker's key (secret); a production worker with search on refuses to start without it. */
    readonly indexerKey: string | undefined;
    /** `TYPESENSE_SEARCH_KEY`: the API's key (secret, search only); a production API with search on refuses to start without it. */
    readonly searchKey: string | undefined;
    /**
     * `TYPESENSE_PREFIX` (`TYPESENSE_PREFIX_TEST` under test, default: the test database name and `_`): the start of every collection,
     * alias, synonym set and curation set name of this environment.
     */
    readonly prefix: string;
    /** `SEARCH_SUGGEST_TIMEOUT_MS`: the timeout of one suggest call to the engine. */
    readonly suggestTimeoutMs: number;
    /** `SEARCH_TIMEOUT_MS`: the timeout of one results-page call to the engine. */
    readonly timeoutMs: number;
    /** `SEARCH_RECONCILE_MINUTES`: how often the worker compares the index with Postgres. */
    readonly reconcileMinutes: number;
  };
  /** The live event streams of the signed-in consoles and the storefront account (decision 037). */
  readonly realtime: {
    /** `REALTIME_ENABLED`: the kill switch. Off answers every stream `503 UNAVAILABLE` and the clients keep polling. */
    readonly enabled: boolean;
    /** `REALTIME_MAX_CONNECTIONS`: open streams of this API process; the next one is `503 UNAVAILABLE`. */
    readonly maxConnections: number;
    /** `REALTIME_MAX_PER_SESSION`: open streams of one session (the tabs that share no lock); the next one is `429`. */
    readonly maxPerSession: number;
    /** `REALTIME_MAX_PER_IP`: open streams of one client address; the next one is `429`. */
    readonly maxPerIp: number;
    /** `REALTIME_HEARTBEAT_SECONDS`: how often every stream gets an `hb` event (under the 30 s cut of a Next rewrite). */
    readonly heartbeatSeconds: number;
    /** `REALTIME_MAX_AGE_SECONDS`: a stream ends after this long (plus up to 120 s of jitter), so the guard runs again. */
    readonly maxAgeSeconds: number;
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
  /**
   * Settings that are accepted but should change; the API and the worker log one warning line per entry at boot (decision 045).
   * Entries: the deprecated `CORS_ORIGINS` outside production; in production a `CONSOLE_ORIGINS` or `SHOP_ORIGINS` that leaves out
   * the origin of its own page(s), and an origin that both lists share.
   */
  readonly warnings: readonly ConfigIssue[];
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
 * Why: a fresh checkout runs after `docker compose up -d` with no `.env`; production refuses these values: the secrets, the database
 * and both Redis URLs, the S3 key pair, the mail URL and the search key (decision 055).
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
  consoleBaseUrl: 'http://localhost:5173',
  storeBaseUrl: 'http://localhost:5175',
  // The console on 5173 (decision 045; development only: production derives the lists from the base URLs, tests default to none).
  consoleOrigins: 'http://localhost:5173,http://127.0.0.1:5173',
  // The merchant portal on 5174 (the origin of `portalBaseUrl`) and the storefront on 5175, which also serves the portal under /merchant.
  shopOrigins: 'http://localhost:5174,http://localhost:5175',
  // The Mailpit of compose.yaml (decision 033): SMTP on 1025, a web UI on 8025 with every message.
  mailSmtpUrl: 'smtp://localhost:1025',
  mailFrom: 'IMEI-HUB <noreply@gsm.local>',
  // The Typesense node of compose.yaml (feature 29): its bootstrap key serves as both process keys outside production.
  typesenseUrl: 'http://localhost:8108',
  typesenseKey: 'gsm-typesense-dev',
} as const;

/** What a Typesense name prefix must look like: lower-case letters, digits and `_`, ending in `_` (feature 29). */
const SEARCH_PREFIX = /^[a-z0-9_]{1,40}_$/;

/**
 * The default Typesense prefix of a test run: the test database's name, made safe, then `_` (`gsm_29_test` gives `gsm_29_test_`).
 *
 * Why: feature 29, plan section 3.3: like the Redis database numbers, each worktree's test database gives its own names in the shared
 * Typesense node, so parallel runs never see each other's collections.
 *
 * @param databaseUrl the test database URL
 * @returns a prefix that matches the prefix rule (at most 40 characters before the final `_`)
 */
export function searchPrefixOf(databaseUrl: string): string {
  let name = 'gsm_test';
  try {
    name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, '')) || name;
  } catch {
    // an invalid URL is reported by its own variable; the default name keeps this one valid
  }
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 40);
  return `${safe}_`;
}

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
  HTTP_HEADERS_TIMEOUT_MS: int(100, 120_000).optional(),
  HTTP_REQUEST_TIMEOUT_MS: int(1_000, 3_600_000).optional(),
  CORS_ORIGINS: z.string().optional(),
  CONSOLE_ORIGINS: z.string().optional(),
  SHOP_ORIGINS: z.string().optional(),
  ERRORS_BASE_URL: httpUrl.optional(),
  PORTAL_BASE_URL: httpUrl.optional(),
  CONSOLE_BASE_URL: httpUrl.optional(),
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
  DATABASE_OWNER_URL: postgresUrl.optional(),
  DATABASE_URL_TEST: postgresUrl.optional(),
  PGHOST: z.string().optional(),
  DATABASE_POOL_MAX: int(1, 200).optional(),
  DATABASE_STATEMENT_TIMEOUT_MS: int(0, 3_600_000).optional(),
  DATABASE_LOCK_TIMEOUT_MS: int(0, 600_000).optional(),
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: int(0, 3_600_000).optional(),
  REDIS_QUEUE_URL: redisUrl.optional(),
  REDIS_CACHE_URL: redisUrl.optional(),
  REDIS_QUEUE_URL_TEST: redisUrl.optional(),
  REDIS_CACHE_URL_TEST: redisUrl.optional(),
  BULL_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9:_-]{1,64}$/, 'use letters, digits, ":", "_" or "-" (1-64 characters)')
    .optional(),
  S3_ENDPOINT: httpUrl.optional(),
  S3_PUBLIC_ENDPOINT: httpUrl.optional(),
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
  LOOKUP_HASH_KEY: z.string().min(32, 'must be at least 32 characters').optional(),
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
  TURNSTILE_MERCHANT_AUTH: z.stringbool().optional(),
  SEARCH_ENABLED: z.stringbool().optional(),
  SEARCH_ENABLED_TEST: z.stringbool().optional(),
  TYPESENSE_URL: httpUrl.optional(),
  TYPESENSE_URL_TEST: httpUrl.optional(),
  TYPESENSE_INDEXER_KEY: z.string().min(1).optional(),
  TYPESENSE_SEARCH_KEY: z.string().min(1).optional(),
  TYPESENSE_PREFIX: z
    .string()
    .regex(SEARCH_PREFIX, 'use lower-case letters, digits and "_", ending in "_" (at most 41)')
    .optional(),
  TYPESENSE_PREFIX_TEST: z
    .string()
    .regex(SEARCH_PREFIX, 'use lower-case letters, digits and "_", ending in "_" (at most 41)')
    .optional(),
  SEARCH_SUGGEST_TIMEOUT_MS: int(50, 2000).optional(),
  SEARCH_TIMEOUT_MS: int(100, 5000).optional(),
  SEARCH_RECONCILE_MINUTES: int(5, 1440).optional(),
  REALTIME_ENABLED: z.stringbool().optional(),
  REALTIME_MAX_CONNECTIONS: int(1, 100_000).optional(),
  REALTIME_MAX_PER_SESSION: int(1, 50).optional(),
  REALTIME_MAX_PER_IP: int(1, 100_000).optional(),
  REALTIME_HEARTBEAT_SECONDS: int(5, 25).optional(),
  REALTIME_MAX_AGE_SECONDS: int(60, 3600).optional(),
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
 * Tells whether a host name is this machine.
 *
 * Why: a process or a script that changes or reads data only trusts a server on this machine without being told so
 * (decision 055): the reset and the seed destroy or fill data, and a process without `NODE_ENV` is development.
 *
 * @param host a host name from a URL (`localhost`, `127.0.0.1`, `[::1]`)
 * @returns true for `localhost`, any `127.x.x.x` address and the IPv6 loopback
 */
export function isLocalHost(host: string): boolean {
  const name = host.toLowerCase();
  return name === 'localhost' || name === '[::1]' || name === '::1' || /^127(?:\.\d{1,3}){3}$/.test(name);
}

/**
 * Tells whether every host a connection URL names is on this machine or a socket directory.
 *
 * Why: decision 055: a process without `NODE_ENV` refuses a remote database, and production's password rules exempt services on this
 * machine. A connection string can name its host outside the authority too (`?host=`, `?hostaddr=`), so every one counts. A Postgres URL
 * that names no host at all is not local by itself: the driver then connects to `PGHOST`, so that value is judged the same way (unset or
 * empty means the driver's own default, this machine).
 *
 * @param url a Postgres or Redis URL
 * @param driverHost `PGHOST` (`AppConfig.database.driverHost`), for a Postgres URL only: a Redis client has no such fallback
 * @returns true when each host is empty, a socket directory (starts with `/`) or passes {@link isLocalHost}; an unparsable URL
 *   answers true (its own variable reports it)
 */
export function databaseIsLocal(url: string, driverHost?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  const named = [parsed.hostname, ...parsed.searchParams.getAll('host').flatMap((value) => value.split(','))].filter(
    (host) => host !== '',
  );
  const hosts = [
    ...named,
    ...parsed.searchParams.getAll('hostaddr').flatMap((value) => value.split(',')),
    // The driver uses `config.host || PGHOST`: only a URL without a host of its own falls back to the environment.
    ...(named.length === 0 && driverHost !== undefined ? driverHost.split(',').map((host) => host.trim()) : []),
  ];
  return hosts.every((host) => host === '' || host.startsWith('/') || isLocalHost(host));
}

/**
 * Tells whether a host name is inside the stack: a loopback address or a name of one label.
 *
 * Why: decision 055: a plain-http object store is accepted in production only when it is the bundled one, reached by its compose
 * service name (`minio`) or on this machine; a dotted name, an address of a network and an IPv6 literal that is not loopback leave the
 * stack and need TLS.
 *
 * @param host the host name of a URL as `URL.hostname` gives it (an IPv6 literal keeps its brackets)
 * @returns true for a loopback address (see {@link isLocalHost}) or a single label of letters, digits, `-` and `_`
 */
export function isStackHost(host: string): boolean {
  return isLocalHost(host) || /^[a-z0-9][a-z0-9_-]*$/i.test(host);
}

/**
 * Tells whether a `TRUST_PROXY` value trusts more than named addresses.
 *
 * Why: decision 055: a range or a hop count lets every host in it choose the client address the API sees, so the boot warns.
 *
 * @param value the parsed setting
 * @returns false for `false`; true for a hop count, a named range or a CIDR shorter than a whole address
 */
export function trustProxyIsRange(value: TrustProxy): boolean {
  if (value === false) return false;
  if (typeof value === 'number') return true;
  return value.some((entry) => {
    if ((NAMED_PROXY_RANGES as readonly string[]).includes(entry)) return true;
    const [address, prefix] = entry.split('/');
    if (prefix === undefined || address === undefined) return false;
    return Number(prefix) < (net.isIP(address) === 4 ? 32 : 128);
  });
}

/**
 * Parses a list of exact browser origins (`CONSOLE_ORIGINS`, `SHOP_ORIGINS` and the deprecated `CORS_ORIGINS`):
 * `https://console.example.com, http://localhost:5173`.
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

/** Why: decision 045 replaced the one list of browser origins with one list per audience; production refuses the old setting. */
const CORS_ORIGINS_REFUSED =
  'is not read in production: set CONSOLE_ORIGINS (the admin console) and SHOP_ORIGINS (the storefront and the merchant portal), or remove it to derive both from CONSOLE_BASE_URL, STORE_BASE_URL and PORTAL_BASE_URL';

/** Why: decision 055: a process without `NODE_ENV` is development, and development only talks to a database on this machine. */
export const NODE_ENV_REMOTE_REFUSED =
  'is not set, and DATABASE_URL names a database that is not on this machine: set NODE_ENV=production on a server, or NODE_ENV=development for a database you run locally';

/** Why: decision 055: a template's `CHANGE_ME` value reaching production would run on a published password or key. */
export const PLACEHOLDER_REFUSED =
  'still holds the CHANGE_ME placeholder of the template: replace it with the real value';

/** Why: decision 055: a service on another machine is reached over a network, so its password must resist guessing. */
export const WEAK_PASSWORD_REFUSED = 'must carry a password of at least 16 characters in production';

/** Why: decision 055: with a range or a hop count, every host inside it can choose the client address the API sees. */
export const TRUST_PROXY_RANGE_WARNING =
  'trusts a range of addresses or a hop count: every host in that range can choose the client address the API sees; list the exact addresses of the proxies (Caddy and the site, docs/OPERATIONS.md section 1)';

/** Why: decision 055: password hashes must keep the cost OWASP recommends for argon2id (decision 007). */
export const ARGON2_FLOOR_REFUSED =
  'with ARGON2_TIME_COST is below the OWASP minimum for argon2id (decision 007): use 19456 KiB with a time cost of 2, or another published pair (47104 KiB with 1 pass, 12288 KiB with 3, 9216 KiB with 4, 7168 KiB with 5), or more of both';

/**
 * The argon2id settings OWASP publishes as equally strong, as memory in KiB and passes, for one lane.
 *
 * Why: decision 007 and decision 055: the floor is exactly these pairs. A product of memory and passes is not equivalent: more passes
 * do not make up for less memory.
 */
const ARGON2_FLOOR_PAIRS: readonly (readonly [memoryKib: number, passes: number])[] = [
  [47_104, 1],
  [19_456, 2],
  [12_288, 3],
  [9_216, 4],
  [7_168, 5],
];

/**
 * Tells whether an argon2id setting reaches the published OWASP minimum.
 *
 * Why: decision 055: production refuses weaker password hashing than the published pairs (decision 007).
 *
 * @param memoryKib `ARGON2_MEMORY_KIB`
 * @param passes `ARGON2_TIME_COST`
 * @returns true when some published pair has both its memory and its passes at or below the setting's
 */
export function argon2MeetsFloor(memoryKib: number, passes: number): boolean {
  return ARGON2_FLOOR_PAIRS.some(([memory, minimumPasses]) => memoryKib >= memory && passes >= minimumPasses);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value) && !Buffer.isBuffer(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * The production rules for the secrets and the services a process reaches over a network (decision 055).
 *
 * Why: a short token, a missing password or a copied development value in production would run on a guessable secret; the
 * services on this machine are exempt from the password rule because the tests run the production rules against local instances.
 *
 * @param raw the parsed variables
 * @param fail reports a problem of one variable
 * @param warn reports a setting that is accepted but should change
 */
function productionSecrets(
  raw: RawEnv,
  fail: (variable: string, message: string) => void,
  warn: (variable: string, message: string) => void,
): void {
  const atLeast = (variable: string, value: string | undefined, min: number) => {
    if (value !== undefined && value.length < min) fail(variable, `must be at least ${min} characters in production`);
  };
  atLeast('METRICS_TOKEN', raw.METRICS_TOKEN, 32);
  atLeast('TYPESENSE_SEARCH_KEY', raw.TYPESENSE_SEARCH_KEY, 32);
  atLeast('TYPESENSE_INDEXER_KEY', raw.TYPESENSE_INDEXER_KEY, 32);
  atLeast('S3_SECRET_ACCESS_KEY', raw.S3_SECRET_ACCESS_KEY, 16);

  // The host of a Redis URL is read the same way as a database host; only a service on another machine needs a password. A database
  // URL without a host reaches the host named by PGHOST, so that is judged too.
  const networkPassword = (variable: string, value: string | undefined, driverHost?: string) => {
    if (value === undefined || databaseIsLocal(value, driverHost)) return;
    let password: string;
    try {
      password = new URL(value).password;
      password = decodeURIComponent(password);
    } catch {
      return; // an unparsable URL is reported by its own variable
    }
    if (password.length < 16) fail(variable, WEAK_PASSWORD_REFUSED);
  };
  networkPassword('DATABASE_URL', raw.DATABASE_URL, raw.PGHOST);
  networkPassword('DATABASE_OWNER_URL', raw.DATABASE_OWNER_URL, raw.PGHOST);
  networkPassword('REDIS_QUEUE_URL', raw.REDIS_QUEUE_URL);
  networkPassword('REDIS_CACHE_URL', raw.REDIS_CACHE_URL);

  const noDevValue = (variable: string, given: string | undefined, devValue: string) => {
    if (given === devValue) fail(variable, 'must not use the development default in production');
  };
  noDevValue('DATABASE_URL', raw.DATABASE_URL, DEV_DEFAULTS.databaseUrl);
  noDevValue('REDIS_QUEUE_URL', raw.REDIS_QUEUE_URL, DEV_DEFAULTS.redisQueueUrl);
  noDevValue('REDIS_CACHE_URL', raw.REDIS_CACHE_URL, DEV_DEFAULTS.redisCacheUrl);
  noDevValue('S3_ACCESS_KEY_ID', raw.S3_ACCESS_KEY_ID, DEV_DEFAULTS.s3AccessKeyId);
  noDevValue('S3_SECRET_ACCESS_KEY', raw.S3_SECRET_ACCESS_KEY, DEV_DEFAULTS.s3SecretAccessKey);
  noDevValue('MAIL_SMTP_URL', raw.MAIL_SMTP_URL, DEV_DEFAULTS.mailSmtpUrl);

  // Presigned links are signed for the public endpoint and opened by a browser, which needs https (decision 055).
  if (raw.S3_PUBLIC_ENDPOINT !== undefined && new URL(raw.S3_PUBLIC_ENDPOINT).protocol !== 'https:') {
    fail('S3_PUBLIC_ENDPOINT', 'must be an https URL in production');
  }
  // A plain-http store is the bundled MinIO inside the stack: a host name of one label (a compose service) or a loopback address. Any
  // other host (a dotted name, an IPv4 address that is not loopback, an IPv6 literal that is not loopback) is reached over a network
  // and needs TLS.
  if (raw.S3_ENDPOINT !== undefined) {
    const store = new URL(raw.S3_ENDPOINT);
    if (store.protocol === 'http:') {
      if (!isStackHost(store.hostname)) {
        fail('S3_ENDPOINT', 'must be an https URL in production when the store is not on the private network');
      } else if (raw.S3_PUBLIC_ENDPOINT === undefined) {
        warn(
          'S3_PUBLIC_ENDPOINT',
          'is not set while S3_ENDPOINT is plain http: file links are signed for that address, which a browser cannot open; set it to the https address of the files host (docs/OPERATIONS.md section 1)',
        );
      }
    }
  }
}

/**
 * Joins the raw variables into the typed config: defaults per mode, production rules, cross-field checks.
 * Problems are reported through `fail` (never thrown) so that one run lists every problem.
 */
function resolveConfig(raw: RawEnv, fail: (variable: string, message: string) => void): AppConfig {
  const env: NodeEnv = raw.NODE_ENV ?? 'development';
  const production = env === 'production';
  const testing = env === 'test';
  // Decision 055: a template's CHANGE_ME value is refused in every variable, before any other rule names that variable.
  if (production) {
    for (const name of KNOWN_VARIABLES) {
      const value = (raw as Record<string, unknown>)[name];
      if (typeof value === 'string' && value.includes('CHANGE_ME')) fail(name, PLACEHOLDER_REFUSED);
    }
  }
  // Decision 055: a process without NODE_ENV is development, and development only talks to a database on this machine.
  if (raw.NODE_ENV === undefined && !databaseIsLocal(raw.DATABASE_URL ?? DEV_DEFAULTS.databaseUrl, raw.PGHOST)) {
    fail('NODE_ENV', NODE_ENV_REMOTE_REFUSED);
  }
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

  const warnings: ConfigIssue[] = [];
  const warn = (variable: string, message: string) => {
    warnings.push({ variable, message });
  };

  // Decision 053: the request time bounds. The headers bound must be shorter than the whole-request bound. There is no bound on the silence
  // of a connection: Bun resets that timer only on bytes that come in, so a live stream (which only writes) would be cut by it.
  const headersTimeoutMs = raw.HTTP_HEADERS_TIMEOUT_MS ?? 20_000;
  const requestTimeoutMs = raw.HTTP_REQUEST_TIMEOUT_MS ?? 600_000;
  if (headersTimeoutMs >= requestTimeoutMs)
    fail('HTTP_HEADERS_TIMEOUT_MS', 'must be shorter than HTTP_REQUEST_TIMEOUT_MS');

  const trust = parseTrustProxy(raw.TRUST_PROXY);
  if (!trust.ok) fail('TRUST_PROXY', trust.message);
  // Decision 055: the API takes the client address from the proxies named here, so production states them (an explicit `false` is
  // a stack without a proxy); a range or a hop count is accepted with a warning.
  if (production && raw.TRUST_PROXY === undefined) fail('TRUST_PROXY', 'is required in production');
  else if (production && trust.ok && trustProxyIsRange(trust.value)) warn('TRUST_PROXY', TRUST_PROXY_RANGE_WARNING);

  // Decision 055: the session limits of the pool. Off under NODE_ENV=test (parallel suites under load); the limit tests set them.
  const limit = (variable: string, given: number | undefined, fallback: number): number => {
    const value = given ?? (testing ? 0 : fallback);
    if (value > 0 && value < 1000) fail(variable, 'must be 0 (no limit) or at least 1000 milliseconds');
    return value;
  };
  const databaseTimeouts = {
    statementMs: limit('DATABASE_STATEMENT_TIMEOUT_MS', raw.DATABASE_STATEMENT_TIMEOUT_MS, 15_000),
    lockMs: limit('DATABASE_LOCK_TIMEOUT_MS', raw.DATABASE_LOCK_TIMEOUT_MS, 5_000),
    idleInTransactionMs: limit(
      'DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS',
      raw.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      60_000,
    ),
  };

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
  // Decision 054: stored lookups have their own key; outside production the pepper stands in, so every existing row keeps matching.
  const lookupHashKey = withDefault('LOOKUP_HASH_KEY', raw.LOOKUP_HASH_KEY, tokenPepper);
  noDevValue('LOOKUP_HASH_KEY', raw.LOOKUP_HASH_KEY, DEV_DEFAULTS.tokenPepper);
  const cookieSecure = raw.COOKIE_SECURE ?? production;
  if (production && !cookieSecure) fail('COOKIE_SECURE', 'must be true in production (session cookies are Secure)');
  // Behind a proxy that adds no forwarding header the public internet looks internal, so production always needs the
  // metrics token (decision 015); Prometheus scrapes with it.
  if (production && raw.METRICS_TOKEN === undefined) fail('METRICS_TOKEN', 'is required in production');
  if (production) productionSecrets(raw, fail, warn);

  // OWASP baseline for argon2id (decision 007); `bun run bench:argon2` helps pick values for the target host.
  const argon2 = {
    memoryKib: raw.ARGON2_MEMORY_KIB ?? 19_456,
    timeCost: raw.ARGON2_TIME_COST ?? 2,
    parallelism: raw.ARGON2_PARALLELISM ?? 1,
  };
  if (argon2.memoryKib < 8 * argon2.parallelism) {
    fail('ARGON2_MEMORY_KIB', 'must be at least 8 times ARGON2_PARALLELISM (argon2 needs 8 KiB per lane)');
  }
  if (production && !argon2MeetsFloor(argon2.memoryKib, argon2.timeCost)) {
    fail('ARGON2_MEMORY_KIB', ARGON2_FLOOR_REFUSED);
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
  // The staff invitation and reset links are `<CONSOLE_BASE_URL>/set-password?token=...` (feature 20).
  const consoleBaseUrl = withDefault('CONSOLE_BASE_URL', raw.CONSOLE_BASE_URL, DEV_DEFAULTS.consoleBaseUrl).replace(
    /\/+$/,
    '',
  );
  // The customer links are `<STORE_BASE_URL>/sign-in?token=...` and `/set-password?token=...` (feature 14b).
  const storeBaseUrl = withDefault('STORE_BASE_URL', raw.STORE_BASE_URL, DEV_DEFAULTS.storeBaseUrl).replace(/\/+$/, '');
  // Decision 045: production serves every browser page and every emailed link over https.
  if (production) {
    for (const [variable, given] of [
      ['ERRORS_BASE_URL', raw.ERRORS_BASE_URL],
      ['PORTAL_BASE_URL', raw.PORTAL_BASE_URL],
      ['CONSOLE_BASE_URL', raw.CONSOLE_BASE_URL],
      ['STORE_BASE_URL', raw.STORE_BASE_URL],
    ] as const) {
      if (given !== undefined && new URL(given).protocol !== 'https:')
        fail(variable, 'must be an https URL in production');
    }
  }
  // Decision 045: one list of browser origins per audience. Outside production the deprecated CORS_ORIGINS stands in for a list
  // that is not set (with a boot warning); production refuses it and derives a list that is not set from the base URLs.
  const originList = (variable: string, text: string): readonly string[] => {
    const parsed = parseCorsOrigins(text);
    if (!parsed.ok) fail(variable, parsed.message);
    return parsed.ok ? parsed.value : [];
  };
  if (production && raw.CORS_ORIGINS !== undefined) fail('CORS_ORIGINS', CORS_ORIGINS_REFUSED);
  const legacyOrigins =
    production || raw.CORS_ORIGINS === undefined ? undefined : originList('CORS_ORIGINS', raw.CORS_ORIGINS);
  const filledByLegacy: string[] = [];
  const audienceOrigins = (
    variable: 'CONSOLE_ORIGINS' | 'SHOP_ORIGINS',
    given: string | undefined,
    derived: () => readonly string[],
    devDefault: string,
  ): readonly string[] => {
    if (given !== undefined) {
      const list = originList(variable, given);
      if (production && list.some((origin) => new URL(origin).protocol !== 'https:')) {
        fail(variable, 'must list https origins only in production');
      }
      return list;
    }
    if (legacyOrigins !== undefined) {
      filledByLegacy.push(variable);
      return legacyOrigins;
    }
    if (production) return derived();
    return testing ? [] : originList(variable, devDefault);
  };
  const consoleOrigins = audienceOrigins(
    'CONSOLE_ORIGINS',
    raw.CONSOLE_ORIGINS,
    () => [new URL(consoleBaseUrl).origin],
    DEV_DEFAULTS.consoleOrigins,
  );
  const shopOrigins = audienceOrigins(
    'SHOP_ORIGINS',
    raw.SHOP_ORIGINS,
    () => [...new Set([new URL(storeBaseUrl).origin, new URL(portalBaseUrl).origin])],
    DEV_DEFAULTS.shopOrigins,
  );
  if (legacyOrigins !== undefined) {
    warn(
      'CORS_ORIGINS',
      filledByLegacy.length > 0
        ? `is deprecated and refused in production: it is read here as ${filledByLegacy.join(' and ')}; set CONSOLE_ORIGINS and SHOP_ORIGINS instead`
        : 'is deprecated and refused in production: it is ignored because CONSOLE_ORIGINS and SHOP_ORIGINS are both set; remove it',
    );
  }
  if (production) {
    // A list that is given is used as it is (it replaces the derived one), so one that leaves out the origin of its own page
    // refuses sign-in from that page. A warning, not a refusal: the list stays as given. Development and tests set short lists on purpose.
    const leftOut = (
      variable: 'CONSOLE_ORIGINS' | 'SHOP_ORIGINS',
      given: string | undefined,
      list: readonly string[],
      pages: ReadonlyArray<readonly [string, string]>,
    ) => {
      if (given === undefined) return;
      const missing = new Map<string, string[]>();
      for (const [name, url] of pages) {
        const origin = new URL(url).origin;
        if (!list.includes(origin)) missing.set(origin, [...(missing.get(origin) ?? []), name]);
      }
      if (missing.size === 0) return;
      const named = [...missing]
        .map(([origin, names]) => `${origin} (the origin of ${names.join(' and ')})`)
        .join(' and ');
      warn(
        variable,
        `does not include ${named}: sign-in from ${missing.size === 1 ? 'that page' : 'those pages'} will be refused, because a list given here is used as it is and replaces the one derived from the base URLs; add it, or remove the line`,
      );
    };
    leftOut('CONSOLE_ORIGINS', raw.CONSOLE_ORIGINS, consoleOrigins, [['CONSOLE_BASE_URL', consoleBaseUrl]]);
    leftOut('SHOP_ORIGINS', raw.SHOP_ORIGINS, shopOrigins, [
      ['STORE_BASE_URL', storeBaseUrl],
      ['PORTAL_BASE_URL', portalBaseUrl],
    ]);
    // One origin per audience is the point of decision 045: a page of a shared origin passes the Origin checks of both surfaces.
    const shared = consoleOrigins.filter((origin) => shopOrigins.includes(origin));
    if (shared.length > 0) {
      warn(
        'CONSOLE_ORIGINS and SHOP_ORIGINS',
        shared.length === 1
          ? `share the origin ${shared[0]}: a page of that origin is trusted on both the staff and the shop surfaces; give each audience its own origin`
          : `share the origins ${shared.join(' and ')}: a page of one of those origins is trusted on both the staff and the shop surfaces; give each audience its own origin`,
      );
    }
  }
  const s3Endpoint = raw.S3_ENDPOINT ?? (production ? undefined : DEV_DEFAULTS.s3Endpoint);
  // Decision 034: production never runs the dummy verifier, which accepts a public test token.
  if (production && raw.TURNSTILE_SECRET_KEY === undefined) fail('TURNSTILE_SECRET_KEY', 'is required in production');
  const turnstileHosts = parseTurnstileHostnames(raw.TURNSTILE_HOSTNAMES ?? '');
  if (!turnstileHosts.ok) fail('TURNSTILE_HOSTNAMES', turnstileHosts.message);
  const alertEmails = parseAlertEmails(raw.ALERTS_EMAIL_TO ?? '');
  if (!alertEmails.ok) fail('ALERTS_EMAIL_TO', alertEmails.message);
  // Feature 29: under NODE_ENV=test only the *_TEST values count (decision 013), and search stays off unless a suite opts in.
  const searchEnabled = testing ? (raw.SEARCH_ENABLED_TEST ?? false) : (raw.SEARCH_ENABLED ?? true);
  const typesenseUrl = (
    testing
      ? (raw.TYPESENSE_URL_TEST ?? DEV_DEFAULTS.typesenseUrl)
      : searchEnabled
        ? withDefault('TYPESENSE_URL', raw.TYPESENSE_URL, DEV_DEFAULTS.typesenseUrl)
        : (raw.TYPESENSE_URL ?? DEV_DEFAULTS.typesenseUrl)
  ).replace(/\/+$/, '');
  // Which process needs which key is decided by the search module (SEARCH_KEY_ROLE): the API the search key, the worker the
  // indexer key. Production never falls back to the development key and refuses it when given.
  noDevValue('TYPESENSE_INDEXER_KEY', raw.TYPESENSE_INDEXER_KEY, DEV_DEFAULTS.typesenseKey);
  noDevValue('TYPESENSE_SEARCH_KEY', raw.TYPESENSE_SEARCH_KEY, DEV_DEFAULTS.typesenseKey);
  const devKey = production ? undefined : DEV_DEFAULTS.typesenseKey;
  const searchPrefix = testing
    ? (raw.TYPESENSE_PREFIX_TEST ?? searchPrefixOf(raw.DATABASE_URL_TEST ?? DEV_DEFAULTS.databaseUrlTest))
    : (raw.TYPESENSE_PREFIX ?? (production ? 'gsm_production_' : 'gsm_development_'));
  const fxProvider = raw.FX_PROVIDER ?? (production ? 'openexchangerates' : 'manual');
  // Decision 049: a production process meant to refresh exchange rates refuses to start without the key, instead of selling on rates
  // that nothing refreshes. FX_PROVIDER=manual is the explicit choice of rates kept by hand.
  if (production && fxProvider === 'openexchangerates' && raw.FX_API_KEY === undefined) {
    fail(
      'FX_API_KEY',
      'is required in production when FX_PROVIDER is openexchangerates (its default there); set FX_PROVIDER=manual to keep the rates by hand',
    );
  }

  return {
    env,
    isProduction: production,
    http: {
      host: raw.HOST ?? '0.0.0.0',
      port: raw.PORT ?? 3000,
      trustProxy: trust.ok ? trust.value : false,
      bodyLimitBytes: raw.BODY_LIMIT_BYTES ?? 1024 * 1024,
      headersTimeoutMs,
      requestTimeoutMs,
      consoleOrigins,
      shopOrigins,
      errorsBaseUrl,
      portalBaseUrl,
      consoleBaseUrl,
      storeBaseUrl,
      geoipCountryHeader: raw.GEOIP_COUNTRY_HEADER?.toLowerCase(),
      referenceDocs: raw.REFERENCE_DOCS ?? (production ? 'staff' : 'open'),
    },
    // Outside production the key stays optional: without it the refresh answers 502 FX_PROVIDER_DOWN. Production requires it for
    // openexchangerates (decision 049).
    fx: {
      provider: fxProvider,
      apiKey: raw.FX_API_KEY,
      timeoutMs: raw.FX_TIMEOUT_MS ?? 5000,
    },
    // Production sends real mail, so both settings must be given there (decision 033); elsewhere Mailpit is the default.
    mail: {
      smtpUrl: withDefault('MAIL_SMTP_URL', raw.MAIL_SMTP_URL, DEV_DEFAULTS.mailSmtpUrl),
      from: withDefault('MAIL_FROM', raw.MAIL_FROM, DEV_DEFAULTS.mailFrom),
      requireTls: production,
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
      ownerUrl: testing ? undefined : raw.DATABASE_OWNER_URL,
      driverHost: raw.PGHOST,
      poolMax: raw.DATABASE_POOL_MAX ?? 10,
      timeouts: databaseTimeouts,
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
      publicEndpoint: raw.S3_PUBLIC_ENDPOINT?.replace(/\/+$/, ''),
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
      lookupHashKey,
      encryptionKeys,
      encryptionActiveKid: activeKid,
      argon2,
    },
    turnstile: {
      secretKey: raw.TURNSTILE_SECRET_KEY,
      hostnames: turnstileHosts.ok ? turnstileHosts.value : [],
      merchantAuth: raw.TURNSTILE_MERCHANT_AUTH ?? production,
    },
    search: {
      enabled: searchEnabled,
      url: typesenseUrl,
      indexerKey: raw.TYPESENSE_INDEXER_KEY ?? devKey,
      searchKey: raw.TYPESENSE_SEARCH_KEY ?? devKey,
      prefix: searchPrefix,
      suggestTimeoutMs: raw.SEARCH_SUGGEST_TIMEOUT_MS ?? 250,
      timeoutMs: raw.SEARCH_TIMEOUT_MS ?? 800,
      reconcileMinutes: raw.SEARCH_RECONCILE_MINUTES ?? 15,
    },
    // Decision 037: a heartbeat under the 30 s cut of a Next rewrite; re-authentication at least every 15 minutes.
    realtime: {
      enabled: raw.REALTIME_ENABLED ?? true,
      maxConnections: raw.REALTIME_MAX_CONNECTIONS ?? 5000,
      maxPerSession: raw.REALTIME_MAX_PER_SESSION ?? 3,
      maxPerIp: raw.REALTIME_MAX_PER_IP ?? 30,
      heartbeatSeconds: raw.REALTIME_HEARTBEAT_SECONDS ?? 15,
      maxAgeSeconds: raw.REALTIME_MAX_AGE_SECONDS ?? 900,
    },
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
    warnings,
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
      headersTimeoutMs: config.http.headersTimeoutMs,
      requestTimeoutMs: config.http.requestTimeoutMs,
      consoleOrigins: config.http.consoleOrigins,
      shopOrigins: config.http.shopOrigins,
      errorsBaseUrl: config.http.errorsBaseUrl,
      portalBaseUrl: config.http.portalBaseUrl,
      consoleBaseUrl: config.http.consoleBaseUrl,
      storeBaseUrl: config.http.storeBaseUrl,
      geoipCountryHeader: config.http.geoipCountryHeader,
      referenceDocs: config.http.referenceDocs,
    },
    fx: { provider: config.fx.provider, apiKey: flag(config.fx.apiKey), timeoutMs: config.fx.timeoutMs },
    mail: { smtpUrl: redactUrl(config.mail.smtpUrl), from: config.mail.from, requireTls: config.mail.requireTls },
    telegram: {
      botToken: flag(config.telegram.botToken),
      botUsername: config.telegram.botUsername,
      webhookSecret: flag(config.telegram.webhookSecret),
    },
    // Addresses and the chat id are personal data: the summary says only how many and whether they are set.
    alerts: { emailRecipients: config.alerts.emailTo.length, telegramChat: flag(config.alerts.telegramChatId) },
    logLevel: config.log.level,
    database: {
      url: redactUrl(config.database.url),
      ownerUrl: flag(config.database.ownerUrl),
      poolMax: config.database.poolMax,
      timeouts: config.database.timeouts,
    },
    redis: {
      queueUrl: redactUrl(config.redis.queueUrl),
      cacheUrl: redactUrl(config.redis.cacheUrl),
      bullPrefix: config.redis.bullPrefix,
    },
    s3: {
      endpoint: redactUrl(config.s3.endpoint),
      publicEndpoint: redactUrl(config.s3.publicEndpoint),
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
      lookupHashKey: flag(config.security.lookupHashKey),
      encryptionKeyIds: Object.keys(config.security.encryptionKeys),
      encryptionActiveKid: config.security.encryptionActiveKid,
      argon2: config.security.argon2,
    },
    turnstile: {
      secretKey: flag(config.turnstile.secretKey),
      hostnames: config.turnstile.hostnames,
      merchantAuth: config.turnstile.merchantAuth,
    },
    search: {
      enabled: config.search.enabled,
      url: redactUrl(config.search.url),
      indexerKey: flag(config.search.indexerKey),
      searchKey: flag(config.search.searchKey),
      prefix: config.search.prefix,
      suggestTimeoutMs: config.search.suggestTimeoutMs,
      timeoutMs: config.search.timeoutMs,
      reconcileMinutes: config.search.reconcileMinutes,
    },
    realtime: config.realtime,
    observability: {
      metricsToken: flag(config.observability.metricsToken),
      workerMetricsPort: config.observability.workerMetricsPort,
      prometheusUrl: redactUrl(config.observability.prometheusUrl),
      sentryDsn: flag(config.observability.sentryDsn),
    },
    build: config.build,
  };
}
