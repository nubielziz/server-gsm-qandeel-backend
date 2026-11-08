// Unit tests for the environment schema (decision 013): defaults, production rules, parsers, redacted summary.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfigError,
  DEV_DEFAULTS,
  ENV_VARIABLES,
  parseCorsOrigins,
  parseEncryptionKeys,
  parseEnv,
  parseTrustProxy,
  parseTurnstileHostnames,
  summarizeConfig,
} from './env';

const KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET = 'x'.repeat(40);

/** A complete, valid production environment; tests remove or change one variable at a time. */
const production = (): Record<string, string> => ({
  NODE_ENV: 'production',
  ERRORS_BASE_URL: 'https://errors.gsm.example/',
  PORTAL_BASE_URL: 'https://portal.gsm.example/',
  DATABASE_URL: 'postgres://app:pw@db.internal:5432/gsm',
  REDIS_QUEUE_URL: 'redis://queue.internal:6379/0',
  REDIS_CACHE_URL: 'redis://cache.internal:6379/0',
  S3_BUCKET: 'gsm-prod-files',
  S3_ACCESS_KEY_ID: 'AKIA-ID',
  S3_SECRET_ACCESS_KEY: 'secret-access-key',
  CSRF_SECRET: SECRET,
  TOKEN_PEPPER: `${SECRET}-pepper`,
  ENCRYPTION_KEYS: `k1:${KEY}`,
  ENCRYPTION_ACTIVE_KID: 'k1',
  METRICS_TOKEN: 'metrics-token-for-prometheus',
  MAIL_SMTP_URL: 'smtps://mailer:pw@smtp.provider.example:465',
  MAIL_FROM: 'GSM <noreply@gsm.example>',
  TURNSTILE_SECRET_KEY: 'turnstile-secret-for-tests',
});

const issuesOf = (env: Record<string, string>) => {
  try {
    parseEnv(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  return [];
};

describe('test runner', () => {
  it('runs with NODE_ENV=test (bunfig.toml preload)', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });
});

describe('parseEnv in development and test', () => {
  it('needs nothing: local defaults match compose.yaml', () => {
    const config = parseEnv({});
    expect(config.env).toBe('development');
    expect(config.http.port).toBe(3000);
    expect(config.http.host).toBe('0.0.0.0');
    expect(config.database.url).toBe(DEV_DEFAULTS.databaseUrl);
    expect(config.database.testUrl).toBe(DEV_DEFAULTS.databaseUrlTest);
    expect(config.redis.queueUrl).toBe('redis://localhost:6379/0');
    expect(config.redis.cacheUrl).toBe('redis://localhost:6380/0');
    expect(config.s3.endpoint).toBe('http://localhost:9000');
    expect(config.s3.forcePathStyle).toBe(true);
    expect(config.security.cookieSecure).toBe(false);
    expect(config.http.referenceDocs).toBe('open');
    expect(config.log.level).toBe('debug');
    expect(config.http.corsOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(config.redis.bullPrefix).toBe('gsm:development:bull');
    expect(config.http.portalBaseUrl).toBe(DEV_DEFAULTS.portalBaseUrl);
  });

  it('reads PORTAL_BASE_URL without a trailing slash and refuses a value that is not an http(s) URL', () => {
    expect(parseEnv({ PORTAL_BASE_URL: 'https://portal.example.com//' }).http.portalBaseUrl).toBe(
      'https://portal.example.com',
    );
    expect(issuesOf({ PORTAL_BASE_URL: 'portal.example.com' }).map((i) => i.variable)).toEqual(['PORTAL_BASE_URL']);
  });

  it('uses warn logs and no CORS origins in test', () => {
    const config = parseEnv({ NODE_ENV: 'test' });
    expect(config.log.level).toBe('warn');
    expect(config.http.corsOrigins).toEqual([]);
    expect(config.redis.bullPrefix).toBe('gsm:test:bull');
  });

  it('points Redis and the bucket at database 1 and the test bucket under NODE_ENV=test, ignoring the normal variables', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      REDIS_QUEUE_URL: 'redis://dev-queue:6379/0',
      REDIS_CACHE_URL: 'redis://dev-cache:6379/0',
      S3_BUCKET: 'gsm-files',
    });
    expect(config.redis.queueUrl).toBe('redis://localhost:6379/1');
    expect(config.redis.cacheUrl).toBe('redis://localhost:6380/1');
    expect(config.s3.bucket).toBe('gsm-files-test');
  });

  it('lets the *_TEST variables override the test defaults (another host, another database)', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      REDIS_QUEUE_URL_TEST: 'redis://127.0.0.1:1/3',
      REDIS_CACHE_URL_TEST: 'redis://127.0.0.1:2/4',
      S3_BUCKET_TEST: 'my-test-bucket',
    });
    expect(config.redis.queueUrl).toBe('redis://127.0.0.1:1/3');
    expect(config.redis.cacheUrl).toBe('redis://127.0.0.1:2/4');
    expect(config.s3.bucket).toBe('my-test-bucket');
  });

  it('does not let the *_TEST variables change development or production', () => {
    const env = {
      REDIS_QUEUE_URL_TEST: 'redis://x:1/9',
      REDIS_CACHE_URL_TEST: 'redis://x:2/9',
      S3_BUCKET_TEST: 'other-test-bucket',
    };
    const development = parseEnv(env);
    expect(development.redis.queueUrl).toBe(DEV_DEFAULTS.redisQueueUrl);
    expect(development.s3.bucket).toBe(DEV_DEFAULTS.s3Bucket);
    const prod = parseEnv({ ...production(), ...env });
    expect(prod.redis.cacheUrl).toBe('redis://cache.internal:6379/0');
    expect(prod.s3.bucket).toBe('gsm-prod-files');
  });

  it('treats empty variables as unset and ignores unknown ones', () => {
    const config = parseEnv({ PORT: '', HOST: '  ', PATH: '/usr/bin', LOG_LEVEL: 'error' });
    expect(config.http.port).toBe(3000);
    expect(config.http.host).toBe('0.0.0.0');
    expect(config.log.level).toBe('error');
  });

  it('returns a deep-frozen config', () => {
    const config = parseEnv({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.http)).toBe(true);
    expect(Object.isFrozen(config.http.corsOrigins)).toBe(true);
    expect(() => {
      (config.http as { port: number }).port = 1;
    }).toThrow();
  });

  it('lists every malformed variable at once, by name, without echoing the value', () => {
    const issues = issuesOf({ PORT: 'abc', DATABASE_URL: 'not a url', LOG_LEVEL: 'loud', CSRF_SECRET: 'short-secret' });
    expect(issues.map((i) => i.variable).sort()).toEqual(['CSRF_SECRET', 'DATABASE_URL', 'LOG_LEVEL', 'PORT']);
    expect(JSON.stringify(issues)).not.toContain('short-secret');
  });
});

describe('parseEnv in production', () => {
  it('accepts a complete environment and normalizes the errors base URL', () => {
    const config = parseEnv(production());
    expect(config.isProduction).toBe(true);
    expect(config.http.errorsBaseUrl).toBe('https://errors.gsm.example');
    expect(config.http.portalBaseUrl).toBe('https://portal.gsm.example');
    expect(config.http.referenceDocs).toBe('staff');
    expect(config.log.level).toBe('info');
    expect(config.security.cookieSecure).toBe(true);
    expect(config.s3.endpoint).toBeUndefined();
    expect(config.s3.forcePathStyle).toBe(false);
    expect(config.http.corsOrigins).toEqual([]);
    expect(Object.keys(config.security.encryptionKeys)).toEqual(['k1']);
  });

  it('fails on an empty environment and names every missing variable', () => {
    const issues = issuesOf({ NODE_ENV: 'production' });
    const names = issues.map((i) => i.variable);
    for (const required of [
      'ERRORS_BASE_URL',
      'PORTAL_BASE_URL',
      'DATABASE_URL',
      'REDIS_QUEUE_URL',
      'REDIS_CACHE_URL',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'CSRF_SECRET',
      'TOKEN_PEPPER',
      'ENCRYPTION_KEYS',
      'ENCRYPTION_ACTIVE_KID',
      'METRICS_TOKEN',
    ]) {
      expect(names).toContain(required);
    }
    expect(issues.every((i) => i.message === 'is required in production')).toBe(true);
  });

  it('puts the list in the error message', () => {
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL: is required in production/);
  });

  it('refuses the development secrets and insecure cookies', () => {
    const issues = issuesOf({
      ...production(),
      CSRF_SECRET: DEV_DEFAULTS.csrfSecret,
      TOKEN_PEPPER: DEV_DEFAULTS.tokenPepper,
      ENCRYPTION_KEYS: `dev1:${DEV_DEFAULTS.encryptionKey}`,
      ENCRYPTION_ACTIVE_KID: 'dev1',
      COOKIE_SECURE: 'false',
    });
    expect(issues.map((i) => i.variable).sort()).toEqual([
      'COOKIE_SECURE',
      'CSRF_SECRET',
      'ENCRYPTION_KEYS',
      'TOKEN_PEPPER',
    ]);
  });

  it('requires the active key id to exist in the keyring', () => {
    const issues = issuesOf({ ...production(), ENCRYPTION_ACTIVE_KID: 'k9' });
    expect(issues).toEqual([
      { variable: 'ENCRYPTION_ACTIVE_KID', message: '"k9" is not one of the key ids in ENCRYPTION_KEYS' },
    ]);
  });

  it('keeps optional integrations optional', () => {
    const config = parseEnv(production());
    expect(config.observability.prometheusUrl).toBeUndefined();
    expect(config.observability.sentryDsn).toBeUndefined();
    expect(config.security.csrfCookieDomain).toBeUndefined();
  });
});

describe('ARGON2_* (decision 007)', () => {
  it('defaults to the OWASP baseline', () => {
    expect(parseEnv({}).security.argon2).toEqual({ memoryKib: 19_456, timeCost: 2, parallelism: 1 });
  });

  it('reads the three cost settings', () => {
    const config = parseEnv({ ARGON2_MEMORY_KIB: '65536', ARGON2_TIME_COST: '3', ARGON2_PARALLELISM: '4' });
    expect(config.security.argon2).toEqual({ memoryKib: 65_536, timeCost: 3, parallelism: 4 });
  });

  it('refuses out-of-range values and memory below 8 KiB per lane, naming the variable', () => {
    expect(issuesOf({ ARGON2_TIME_COST: '0' }).map((i) => i.variable)).toEqual(['ARGON2_TIME_COST']);
    expect(issuesOf({ ARGON2_PARALLELISM: '99' }).map((i) => i.variable)).toEqual(['ARGON2_PARALLELISM']);
    expect(issuesOf({ ARGON2_MEMORY_KIB: 'lots' }).map((i) => i.variable)).toEqual(['ARGON2_MEMORY_KIB']);
    expect(issuesOf({ ARGON2_MEMORY_KIB: '16', ARGON2_PARALLELISM: '4' })).toEqual([
      { variable: 'ARGON2_MEMORY_KIB', message: expect.stringContaining('8 times ARGON2_PARALLELISM') },
    ]);
  });

  it('is part of the redacted summary (the cost is not a secret)', () => {
    const text = JSON.stringify(summarizeConfig(parseEnv({})));
    expect(text).toContain('"argon2":{"memoryKib":19456,"timeCost":2,"parallelism":1}');
  });
});

describe('MAIL_* and TELEGRAM_* (decision 033)', () => {
  it('defaults to the Mailpit of compose.yaml outside production and leaves Telegram unset', () => {
    const config = parseEnv({});
    expect(config.mail).toEqual({ smtpUrl: 'smtp://localhost:1025', from: 'GSM <noreply@gsm.local>' });
    expect(config.telegram).toEqual({ botToken: undefined, botUsername: undefined, webhookSecret: undefined });
  });

  it('requires both mail settings in production, and nothing for Telegram', () => {
    const { MAIL_SMTP_URL: _smtp, MAIL_FROM: _from, ...without } = production();
    expect(issuesOf(without).map((i) => i.variable)).toEqual(['MAIL_SMTP_URL', 'MAIL_FROM']);
    const config = parseEnv(production());
    expect(config.mail.smtpUrl).toBe('smtps://mailer:pw@smtp.provider.example:465');
    expect(config.telegram.botToken).toBeUndefined();
  });

  it('checks the formats and names the variable without echoing the value', () => {
    const issues = issuesOf({
      MAIL_SMTP_URL: 'http://mail.example',
      MAIL_FROM: 'not an address',
      TELEGRAM_BOT_USERNAME: '@bot',
      TELEGRAM_WEBHOOK_SECRET: 'short secret!',
    });
    expect(issues.map((i) => i.variable).sort()).toEqual([
      'MAIL_FROM',
      'MAIL_SMTP_URL',
      'TELEGRAM_BOT_USERNAME',
      'TELEGRAM_WEBHOOK_SECRET',
    ]);
    expect(JSON.stringify(issues)).not.toContain('short secret');
    expect(issuesOf({ MAIL_FROM: 'noreply@gsm.example' })).toEqual([]);
  });

  it('reads the Telegram settings and keeps every secret out of the summary', () => {
    const config = parseEnv({
      TELEGRAM_BOT_TOKEN: '123456:ABC-secret-token',
      TELEGRAM_BOT_USERNAME: 'gsm_supply_bot',
      TELEGRAM_WEBHOOK_SECRET: 'w'.repeat(32),
      MAIL_SMTP_URL: 'smtp://user:smtp-password@mail.example:587',
    });
    expect(config.telegram.botUsername).toBe('gsm_supply_bot');
    const text = JSON.stringify(summarizeConfig(config));
    expect(text).not.toContain('ABC-secret-token');
    expect(text).not.toContain('smtp-password');
    expect(text).not.toContain('w'.repeat(32));
    expect(text).toContain('"botToken":"[set]"');
  });
});

describe('METRICS_TOKEN', () => {
  it('is required in production, so a proxy without forwarding headers cannot expose /metrics', () => {
    const { METRICS_TOKEN: _unused, ...withoutToken } = production();
    expect(issuesOf(withoutToken)).toEqual([{ variable: 'METRICS_TOKEN', message: 'is required in production' }]);
    expect(parseEnv(production()).observability.metricsToken).toBe('metrics-token-for-prometheus');
  });

  it('stays optional outside production', () => {
    expect(parseEnv({ NODE_ENV: 'development' }).observability.metricsToken).toBeUndefined();
  });
});

describe('FX_* (RESOLUTIONS money-9)', () => {
  it('defaults to the manual driver outside production and openexchangerates in production', () => {
    const development = parseEnv({}).fx;
    expect(development).toEqual({ provider: 'manual', apiKey: undefined, timeoutMs: 5000 });
    expect(parseEnv({ NODE_ENV: 'test' }).fx.provider).toBe('manual');
    expect(parseEnv(production()).fx).toEqual({ provider: 'openexchangerates', apiKey: undefined, timeoutMs: 5000 });
  });

  it('reads the provider, the key and the timeout', () => {
    const fx = parseEnv({ FX_PROVIDER: 'openexchangerates', FX_API_KEY: 'app-id-123', FX_TIMEOUT_MS: '2500' }).fx;
    expect(fx).toEqual({ provider: 'openexchangerates', apiKey: 'app-id-123', timeoutMs: 2500 });
    expect(parseEnv({ ...production(), FX_PROVIDER: 'manual' }).fx.provider).toBe('manual');
  });

  it('keeps the key optional in production (an unconfigured provider is a 502 at call time, not a boot failure)', () => {
    expect(issuesOf({ ...production(), FX_PROVIDER: 'openexchangerates' })).toEqual([]);
  });

  it('refuses an unknown driver and a timeout outside 100-60000 ms, naming the variable', () => {
    expect(issuesOf({ FX_PROVIDER: 'ecb' }).map((i) => i.variable)).toEqual(['FX_PROVIDER']);
    expect(issuesOf({ FX_TIMEOUT_MS: '50' }).map((i) => i.variable)).toEqual(['FX_TIMEOUT_MS']);
    expect(issuesOf({ FX_TIMEOUT_MS: 'soon' }).map((i) => i.variable)).toEqual(['FX_TIMEOUT_MS']);
  });

  it('redacts the key in the summary but shows the driver and the timeout', () => {
    const text = JSON.stringify(
      summarizeConfig(parseEnv({ FX_PROVIDER: 'openexchangerates', FX_API_KEY: 'app-id-123' })),
    );
    expect(text).not.toContain('app-id-123');
    expect(text).toContain('"fx":{"provider":"openexchangerates","apiKey":"[set]","timeoutMs":5000}');
  });
});

describe('GEOIP_COUNTRY_HEADER', () => {
  it('is unset by default, so the country lookup by header is skipped', () => {
    expect(parseEnv({}).http.geoipCountryHeader).toBeUndefined();
    expect(parseEnv(production()).http.geoipCountryHeader).toBeUndefined();
  });

  it('is read as a lower-case header name', () => {
    expect(parseEnv({ GEOIP_COUNTRY_HEADER: 'CF-IPCountry' }).http.geoipCountryHeader).toBe('cf-ipcountry');
  });

  it('refuses a value that is not a header name', () => {
    expect(issuesOf({ GEOIP_COUNTRY_HEADER: 'cf ipcountry' }).map((i) => i.variable)).toEqual(['GEOIP_COUNTRY_HEADER']);
    expect(issuesOf({ GEOIP_COUNTRY_HEADER: 'x-country:' }).map((i) => i.variable)).toEqual(['GEOIP_COUNTRY_HEADER']);
  });
});

describe('Turnstile settings (decision 034)', () => {
  it('has no secret and no host list by default, which selects the dummy verifier', () => {
    expect(parseEnv({}).turnstile).toEqual({ secretKey: undefined, hostnames: [] });
  });

  it('requires the secret in production', () => {
    const env = production();
    delete env.TURNSTILE_SECRET_KEY;
    expect(issuesOf(env)).toEqual([{ variable: 'TURNSTILE_SECRET_KEY', message: 'is required in production' }]);
  });

  it('reads the secret and a host list (lower-cased, de-duplicated)', () => {
    const config = parseEnv({
      ...production(),
      TURNSTILE_HOSTNAMES: 'Shop.Example.com, shop.example.com ,www.example.com',
    });
    expect(config.turnstile.secretKey).toBe('turnstile-secret-for-tests');
    expect(config.turnstile.hostnames).toEqual(['shop.example.com', 'www.example.com']);
  });

  it('refuses a host entry with a scheme, a port or a path', () => {
    for (const bad of ['https://shop.example.com', 'shop.example.com:443', 'shop.example.com/x', 'bad host'])
      expect(issuesOf({ TURNSTILE_HOSTNAMES: bad }).map((i) => i.variable)).toEqual(['TURNSTILE_HOSTNAMES']);
    expect(parseTurnstileHostnames(' , ')).toEqual({ ok: true, value: [] });
  });

  it('keeps the secret out of the boot summary', () => {
    const summary = JSON.stringify(summarizeConfig(parseEnv(production())));
    expect(summary).not.toContain('turnstile-secret-for-tests');
    expect(summary).toContain('"secretKey":"[set]"');
  });
});

describe('parseTrustProxy', () => {
  it('trusts nobody by default', () => {
    for (const value of [undefined, '', 'false', '0', '  '])
      expect(parseTrustProxy(value)).toEqual({ ok: true, value: false });
  });

  it('reads a hop count', () => {
    expect(parseTrustProxy('1')).toEqual({ ok: true, value: 1 });
    expect(parseTrustProxy('2')).toEqual({ ok: true, value: 2 });
    expect(parseTrustProxy('11').ok).toBe(false);
  });

  it('reads IP, CIDR and named ranges', () => {
    expect(parseTrustProxy('10.0.0.0/8, 192.168.1.5,loopback,fd00::/8')).toEqual({
      ok: true,
      value: ['10.0.0.0/8', '192.168.1.5', 'loopback', 'fd00::/8'],
    });
  });

  it('refuses garbage, bad prefixes and trust-everything', () => {
    for (const value of [
      'true',
      'yes',
      '10.0.0.0/33',
      '10.0.0.0/8/9',
      'proxy.example.com',
      '::1/129',
      '0.0.0.0/0',
      '::/0',
      '1,2',
    ]) {
      expect(parseTrustProxy(value).ok).toBe(false);
    }
  });
});

describe('parseCorsOrigins', () => {
  it('keeps exact origins and drops duplicates', () => {
    expect(parseCorsOrigins('https://console.example.com, http://localhost:5173,https://console.example.com')).toEqual({
      ok: true,
      value: ['https://console.example.com', 'http://localhost:5173'],
    });
    expect(parseCorsOrigins('')).toEqual({ ok: true, value: [] });
  });

  it('refuses wildcards, paths, trailing slashes, default ports and other schemes', () => {
    for (const value of [
      '*',
      'https://a.example/',
      'https://a.example/app',
      'https://a.example:443',
      'ftp://a.example',
      'a.example',
    ]) {
      expect(parseCorsOrigins(value).ok).toBe(false);
    }
  });
});

describe('parseEncryptionKeys', () => {
  it('reads kid:base64 pairs of 32 bytes', () => {
    const parsed = parseEncryptionKeys(`k1:${KEY}, k2:${Buffer.alloc(32, 9).toString('base64')}`);
    expect(parsed.ok && Object.keys(parsed.value)).toEqual(['k1', 'k2']);
    expect(parsed.ok && parsed.value.k1?.length).toBe(32);
  });

  it('refuses short keys, bad ids, missing separators and duplicates', () => {
    for (const value of [
      `k1:${Buffer.alloc(16).toString('base64')}`,
      `bad id:${KEY}`,
      KEY,
      `k1:${KEY},k1:${KEY}`,
      '',
      'k1:not base64!',
    ]) {
      expect(parseEncryptionKeys(value).ok).toBe(false);
    }
  });
});

describe('summarizeConfig', () => {
  it('never contains secrets, passwords or key material', () => {
    const config = parseEnv({
      ...production(),
      METRICS_TOKEN: 'metrics-token-1234567890',
      SENTRY_DSN: 'https://public@sentry.example.com/1',
      PROMETHEUS_URL: 'http://user:promPassword@prometheus.internal:9090',
    });
    const text = JSON.stringify(summarizeConfig(config));
    for (const secret of [
      SECRET,
      KEY,
      'pw@',
      'secret-access-key',
      'AKIA-ID',
      'metrics-token-1234567890',
      'promPassword',
      'public@sentry',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('postgres://app:***@db.internal:5432/gsm');
    expect(text).toContain('"encryptionKeyIds":["k1"]');
    expect(text).toContain('"metricsToken":"[set]"');
  });
});

describe('.env.example', () => {
  const text = readFileSync(join(import.meta.dir, '../../.env.example'), 'utf8');
  /** Same reading as Bun's loader: NAME=value, an inline comment starts at whitespace + "#". */
  const values = Object.fromEntries(
    text
      .split('\n')
      .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1]!, match[2]!.replace(/\s+#.*$/, '').trim()]),
  );

  it('lists every variable the schema reads', () => {
    for (const name of ENV_VARIABLES) expect(Object.keys(values), name).toContain(name);
  });

  it('documents nothing the application does not read, apart from tooling variables', () => {
    const unknown = Object.keys(values).filter((name) => !ENV_VARIABLES.includes(name));
    expect(unknown).toEqual(['FRONTEND_DIR']);
  });

  it('is a valid development environment as it stands', () => {
    const config = parseEnv(values);
    expect(config.env).toBe('development');
    expect(config.http.port).toBe(3000);
    expect(config.database.url).toBe(DEV_DEFAULTS.databaseUrl);
  });
});
