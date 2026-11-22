// Unit tests for the environment schema (decision 013): defaults, production rules, parsers, redacted summary.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
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
  parseAlertEmails,
  parseCorsOrigins,
  parseEncryptionKeys,
  parseEnv,
  parseTrustProxy,
  parseTurnstileHostnames,
  searchPrefixOf,
  summarizeConfig,
  trustProxyIsRange,
} from '@src/config/env';

const KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET = 'x'.repeat(40);

/** A complete, valid production environment; tests remove or change one variable at a time. */
const production = (): Record<string, string> => ({
  NODE_ENV: 'production',
  ERRORS_BASE_URL: 'https://errors.gsm.example/',
  PORTAL_BASE_URL: 'https://portal.gsm.example/',
  CONSOLE_BASE_URL: 'https://admin.gsm.example/',
  STORE_BASE_URL: 'https://shop.gsm.example/',
  DATABASE_URL: 'postgres://app:app-password-0123456789@db.internal:5432/gsm',
  REDIS_QUEUE_URL: 'redis://:queue-password-0123456789@queue.internal:6379/0',
  REDIS_CACHE_URL: 'redis://:cache-password-0123456789@cache.internal:6379/0',
  TRUST_PROXY: '172.30.1.2,172.30.1.3',
  S3_BUCKET: 'gsm-prod-files',
  S3_ACCESS_KEY_ID: 'AKIA-ID',
  S3_SECRET_ACCESS_KEY: 'secret-access-key',
  CSRF_SECRET: SECRET,
  TOKEN_PEPPER: `${SECRET}-pepper`,
  LOOKUP_HASH_KEY: 'l'.repeat(40),
  ENCRYPTION_KEYS: `k1:${KEY}`,
  ENCRYPTION_ACTIVE_KID: 'k1',
  METRICS_TOKEN: 'metrics-token-for-prometheus-0123456',
  MAIL_SMTP_URL: 'smtps://mailer:pw@smtp.provider.example:465',
  MAIL_FROM: 'IMEI-HUB <noreply@gsm.example>',
  TURNSTILE_SECRET_KEY: 'turnstile-secret-for-tests',
  TYPESENSE_URL: 'http://typesense:8108/',
  FX_API_KEY: 'fx-app-id-for-tests',
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
    expect(config.http.consoleOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(config.http.shopOrigins).toEqual(['http://localhost:5174', 'http://localhost:5175']);
    expect(config.warnings).toEqual([]);
    expect(config.redis.bullPrefix).toBe('gsm:development:bull');
    expect(config.http.portalBaseUrl).toBe(DEV_DEFAULTS.portalBaseUrl);
  });

  it('gives each audience its own origins: the development defaults, none under test, the base URLs in production (decision 045)', () => {
    const portalOrigin = new URL(DEV_DEFAULTS.portalBaseUrl).origin;
    expect(portalOrigin).toBe('http://localhost:5174');
    const development = parseEnv({}).http;
    expect(development.shopOrigins).toContain(portalOrigin);
    expect(development.consoleOrigins).not.toContain(portalOrigin);
    // Tests default to no browser origins, with or without a portal URL.
    for (const env of [{ NODE_ENV: 'test' }, { NODE_ENV: 'test', PORTAL_BASE_URL: 'http://localhost:5174' }]) {
      const config = parseEnv(env).http;
      expect(config.consoleOrigins).toEqual([]);
      expect(config.shopOrigins).toEqual([]);
    }
    // Production derives them: the console's from CONSOLE_BASE_URL, the shop's from STORE_BASE_URL and PORTAL_BASE_URL.
    const prod = parseEnv(production()).http;
    expect(prod.consoleOrigins).toEqual(['https://admin.gsm.example']);
    expect(prod.shopOrigins).toEqual(['https://shop.gsm.example', 'https://portal.gsm.example']);
    // A portal served under the shop's host is one origin, not two.
    const shared = parseEnv({ ...production(), PORTAL_BASE_URL: 'https://shop.gsm.example/merchant' }).http;
    expect(shared.shopOrigins).toEqual(['https://shop.gsm.example']);
  });

  it('reads CONSOLE_ORIGINS and SHOP_ORIGINS as exact origin lists, each for its own audience', () => {
    const given = {
      CONSOLE_ORIGINS: 'https://console.example.com, https://console.example.com,http://localhost:4000',
      SHOP_ORIGINS: 'https://shop.example.com',
    };
    const development = parseEnv(given);
    expect(development.http.consoleOrigins).toEqual(['https://console.example.com', 'http://localhost:4000']);
    expect(development.http.shopOrigins).toEqual(['https://shop.example.com']);
    expect(development.warnings).toEqual([]);
    const prod = parseEnv({
      ...production(),
      CONSOLE_ORIGINS: 'https://admin.gsm.example,https://console.gsm.example',
      SHOP_ORIGINS: 'https://shop.gsm.example',
    });
    expect(prod.http.consoleOrigins).toEqual(['https://admin.gsm.example', 'https://console.gsm.example']);
    expect(prod.http.shopOrigins).toEqual(['https://shop.gsm.example']);
    // One list given: the other is still the default of its audience.
    expect(parseEnv({ SHOP_ORIGINS: 'https://shop.example.com' }).http.consoleOrigins).toEqual([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
    for (const bad of ['*', 'https://a.example/app']) {
      expect(issuesOf({ CONSOLE_ORIGINS: bad }).map((issue) => issue.variable)).toEqual(['CONSOLE_ORIGINS']);
      expect(issuesOf({ SHOP_ORIGINS: bad }).map((issue) => issue.variable)).toEqual(['SHOP_ORIGINS']);
    }
  });

  it('reads the deprecated CORS_ORIGINS outside production for each list that is not set, with a warning', () => {
    const origin = 'https://console.example.com';
    const warning = (message: string) => [{ variable: 'CORS_ORIGINS', message }];
    for (const NODE_ENV of ['development', 'test']) {
      const only = parseEnv({ NODE_ENV, CORS_ORIGINS: origin });
      expect(only.http.consoleOrigins).toEqual([origin]);
      expect(only.http.shopOrigins).toEqual([origin]);
      expect(only.warnings).toEqual(
        warning(
          'is deprecated and refused in production: it is read here as CONSOLE_ORIGINS and SHOP_ORIGINS; set CONSOLE_ORIGINS and SHOP_ORIGINS instead',
        ),
      );

      const one = parseEnv({ NODE_ENV, CORS_ORIGINS: origin, CONSOLE_ORIGINS: 'https://other.example.com' });
      expect(one.http.consoleOrigins).toEqual(['https://other.example.com']);
      expect(one.http.shopOrigins).toEqual([origin]);
      expect(one.warnings).toEqual(
        warning(
          'is deprecated and refused in production: it is read here as SHOP_ORIGINS; set CONSOLE_ORIGINS and SHOP_ORIGINS instead',
        ),
      );

      const both = parseEnv({
        NODE_ENV,
        CORS_ORIGINS: origin,
        CONSOLE_ORIGINS: 'https://other.example.com',
        SHOP_ORIGINS: 'https://shop.example.com',
      });
      expect(both.http.consoleOrigins).toEqual(['https://other.example.com']);
      expect(both.http.shopOrigins).toEqual(['https://shop.example.com']);
      expect(both.warnings).toEqual(
        warning(
          'is deprecated and refused in production: it is ignored because CONSOLE_ORIGINS and SHOP_ORIGINS are both set; remove it',
        ),
      );
    }
    // A malformed old value still stops the boot outside production.
    expect(issuesOf({ CORS_ORIGINS: '*' }).map((issue) => issue.variable)).toEqual(['CORS_ORIGINS']);
  });

  it('refuses http origins and base URLs in production, and accepts them outside it (decision 045)', () => {
    for (const variable of ['ERRORS_BASE_URL', 'PORTAL_BASE_URL', 'CONSOLE_BASE_URL', 'STORE_BASE_URL']) {
      expect(issuesOf({ ...production(), [variable]: 'http://plain.gsm.example' })).toEqual([
        { variable, message: 'must be an https URL in production' },
      ]);
      expect(issuesOf({ [variable]: 'http://plain.gsm.example' })).toEqual([]);
    }
    expect(issuesOf({ ...production(), CONSOLE_ORIGINS: 'http://admin.gsm.example' })).toEqual([
      { variable: 'CONSOLE_ORIGINS', message: 'must list https origins only in production' },
    ]);
    expect(issuesOf({ ...production(), SHOP_ORIGINS: 'https://shop.gsm.example,http://portal.gsm.example' })).toEqual([
      { variable: 'SHOP_ORIGINS', message: 'must list https origins only in production' },
    ]);
    expect(issuesOf({ CONSOLE_ORIGINS: 'http://admin.gsm.example', SHOP_ORIGINS: 'http://shop.gsm.example' })).toEqual(
      [],
    );
  });

  it('reads PORTAL_BASE_URL without a trailing slash and refuses a value that is not an http(s) URL', () => {
    expect(parseEnv({ PORTAL_BASE_URL: 'https://portal.example.com//' }).http.portalBaseUrl).toBe(
      'https://portal.example.com',
    );
    expect(issuesOf({ PORTAL_BASE_URL: 'portal.example.com' }).map((i) => i.variable)).toEqual(['PORTAL_BASE_URL']);
  });

  it('reads CONSOLE_BASE_URL without a trailing slash, requires it in production and refuses a value that is not an http(s) URL', () => {
    expect(parseEnv({ CONSOLE_BASE_URL: 'https://admin.example.com//' }).http.consoleBaseUrl).toBe(
      'https://admin.example.com',
    );
    expect(parseEnv({}).http.consoleBaseUrl).toBe(DEV_DEFAULTS.consoleBaseUrl);
    expect(issuesOf({ CONSOLE_BASE_URL: 'admin.example.com' }).map((i) => i.variable)).toEqual(['CONSOLE_BASE_URL']);
    const withoutIt = production();
    delete withoutIt.CONSOLE_BASE_URL;
    expect(issuesOf(withoutIt).map((i) => i.variable)).toEqual(['CONSOLE_BASE_URL']);
  });

  it('reads STORE_BASE_URL without a trailing slash and refuses a value that is not an http(s) URL', () => {
    expect(parseEnv({ STORE_BASE_URL: 'https://shop.example.com//' }).http.storeBaseUrl).toBe(
      'https://shop.example.com',
    );
    expect(parseEnv({}).http.storeBaseUrl).toBe(DEV_DEFAULTS.storeBaseUrl);
    expect(issuesOf({ STORE_BASE_URL: 'shop.example.com' }).map((i) => i.variable)).toEqual(['STORE_BASE_URL']);
  });

  it('uses warn logs and no browser origins in test', () => {
    const config = parseEnv({ NODE_ENV: 'test' });
    expect(config.log.level).toBe('warn');
    expect(config.http.consoleOrigins).toEqual([]);
    expect(config.http.shopOrigins).toEqual([]);
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
    expect(prod.redis.cacheUrl).toBe('redis://:cache-password-0123456789@cache.internal:6379/0');
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
    expect(Object.isFrozen(config.http.consoleOrigins)).toBe(true);
    expect(Object.isFrozen(config.warnings)).toBe(true);
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
    expect(config.http.storeBaseUrl).toBe('https://shop.gsm.example');
    expect(config.http.referenceDocs).toBe('staff');
    expect(config.log.level).toBe('info');
    expect(config.security.cookieSecure).toBe(true);
    expect(config.s3.endpoint).toBeUndefined();
    expect(config.s3.forcePathStyle).toBe(false);
    expect(config.http.consoleOrigins).toEqual(['https://admin.gsm.example']);
    expect(config.http.shopOrigins).toEqual(['https://shop.gsm.example', 'https://portal.gsm.example']);
    expect(Object.keys(config.security.encryptionKeys)).toEqual(['k1']);
  });

  it('refuses CORS_ORIGINS in production and names the two settings that replace it', () => {
    expect(issuesOf({ ...production(), CORS_ORIGINS: 'https://admin.gsm.example' })).toEqual([
      {
        variable: 'CORS_ORIGINS',
        message:
          'is not read in production: set CONSOLE_ORIGINS (the admin console) and SHOP_ORIGINS (the storefront and the merchant portal), or remove it to derive both from CONSOLE_BASE_URL, STORE_BASE_URL and PORTAL_BASE_URL',
      },
    ]);
  });

  describe('origin lists that leave out their own page or share an origin (decision 045)', () => {
    const replaced =
      'because a list given here is used as it is and replaces the one derived from the base URLs; add it, or remove the line';

    it('warns when CONSOLE_ORIGINS is given without the origin of CONSOLE_BASE_URL, and keeps the list as given', () => {
      const config = parseEnv({ ...production(), CONSOLE_ORIGINS: 'https://other.gsm.example' });
      expect(config.http.consoleOrigins).toEqual(['https://other.gsm.example']);
      expect(config.warnings).toEqual([
        {
          variable: 'CONSOLE_ORIGINS',
          message: `does not include https://admin.gsm.example (the origin of CONSOLE_BASE_URL): sign-in from that page will be refused, ${replaced}`,
        },
      ]);
    });

    it('warns when SHOP_ORIGINS is given without the origin of STORE_BASE_URL or of PORTAL_BASE_URL', () => {
      const withoutPortal = parseEnv({ ...production(), SHOP_ORIGINS: 'https://shop.gsm.example' });
      expect(withoutPortal.http.shopOrigins).toEqual(['https://shop.gsm.example']);
      expect(withoutPortal.warnings).toEqual([
        {
          variable: 'SHOP_ORIGINS',
          message: `does not include https://portal.gsm.example (the origin of PORTAL_BASE_URL): sign-in from that page will be refused, ${replaced}`,
        },
      ]);
      const withoutStore = parseEnv({ ...production(), SHOP_ORIGINS: 'https://portal.gsm.example' });
      expect(withoutStore.warnings).toEqual([
        {
          variable: 'SHOP_ORIGINS',
          message: `does not include https://shop.gsm.example (the origin of STORE_BASE_URL): sign-in from that page will be refused, ${replaced}`,
        },
      ]);
      const neither = parseEnv({ ...production(), SHOP_ORIGINS: 'https://elsewhere.gsm.example' });
      expect(neither.warnings).toEqual([
        {
          variable: 'SHOP_ORIGINS',
          message: `does not include https://shop.gsm.example (the origin of STORE_BASE_URL) and https://portal.gsm.example (the origin of PORTAL_BASE_URL): sign-in from those pages will be refused, ${replaced}`,
        },
      ]);
      // A portal served under the shop's host is one origin: it is named once, with both variables.
      const sharedHost = parseEnv({
        ...production(),
        PORTAL_BASE_URL: 'https://shop.gsm.example/merchant',
        SHOP_ORIGINS: 'https://elsewhere.gsm.example',
      });
      expect(sharedHost.warnings).toEqual([
        {
          variable: 'SHOP_ORIGINS',
          message: `does not include https://shop.gsm.example (the origin of STORE_BASE_URL and PORTAL_BASE_URL): sign-in from that page will be refused, ${replaced}`,
        },
      ]);
    });

    it('does not warn when a given list includes the origins of the base URLs, or when no list is given', () => {
      expect(parseEnv(production()).warnings).toEqual([]);
      const config = parseEnv({
        ...production(),
        CONSOLE_ORIGINS: 'https://admin.gsm.example,https://console.gsm.example',
        SHOP_ORIGINS: 'https://portal.gsm.example,https://shop.gsm.example,https://extra.gsm.example',
      });
      expect(config.http.shopOrigins).toEqual([
        'https://portal.gsm.example',
        'https://shop.gsm.example',
        'https://extra.gsm.example',
      ]);
      expect(config.warnings).toEqual([]);
    });

    it('does not warn about a short list outside production', () => {
      const given = { CONSOLE_ORIGINS: 'https://other.example.com', SHOP_ORIGINS: 'https://elsewhere.example.com' };
      for (const NODE_ENV of ['development', 'test']) {
        expect(parseEnv({ NODE_ENV, ...given }).warnings).toEqual([]);
        // Lists that share an origin are the development default of a single-host setup.
        const same = { CONSOLE_ORIGINS: 'http://localhost:5173', SHOP_ORIGINS: 'http://localhost:5173' };
        expect(parseEnv({ NODE_ENV, ...same }).warnings).toEqual([]);
      }
      expect(parseEnv(given).warnings).toEqual([]);
    });

    it('warns once when the two lists share an origin, given or derived, and names it', () => {
      const given = parseEnv({
        ...production(),
        CONSOLE_ORIGINS: 'https://admin.gsm.example,https://shop.gsm.example',
      });
      expect(given.http.consoleOrigins).toEqual(['https://admin.gsm.example', 'https://shop.gsm.example']);
      expect(given.warnings).toEqual([
        {
          variable: 'CONSOLE_ORIGINS and SHOP_ORIGINS',
          message:
            'share the origin https://shop.gsm.example: a page of that origin is trusted on both the staff and the shop surfaces; give each audience its own origin',
        },
      ]);
      // Derived: the console and the shop served from one host.
      const derived = parseEnv({ ...production(), CONSOLE_BASE_URL: 'https://shop.gsm.example/' });
      expect(derived.warnings).toEqual(given.warnings);
      // Two shared origins: still one entry.
      const two = parseEnv({
        ...production(),
        CONSOLE_ORIGINS: 'https://admin.gsm.example,https://shop.gsm.example,https://portal.gsm.example',
      });
      expect(two.warnings).toEqual([
        {
          variable: 'CONSOLE_ORIGINS and SHOP_ORIGINS',
          message:
            'share the origins https://shop.gsm.example and https://portal.gsm.example: a page of one of those origins is trusted on both the staff and the shop surfaces; give each audience its own origin',
        },
      ]);
    });

    it('does not warn about a shared origin when the lists are distinct', () => {
      const config = parseEnv({
        ...production(),
        CONSOLE_ORIGINS: 'https://admin.gsm.example,https://console.gsm.example',
        SHOP_ORIGINS: 'https://shop.gsm.example,https://portal.gsm.example',
      });
      expect(config.warnings).toEqual([]);
    });
  });

  it('fails on an empty environment and names every missing variable', () => {
    const issues = issuesOf({ NODE_ENV: 'production' });
    const names = issues.map((i) => i.variable);
    for (const required of [
      'ERRORS_BASE_URL',
      'PORTAL_BASE_URL',
      'CONSOLE_BASE_URL',
      'STORE_BASE_URL',
      'TRUST_PROXY',
      'DATABASE_URL',
      'REDIS_QUEUE_URL',
      'REDIS_CACHE_URL',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'CSRF_SECRET',
      'TOKEN_PEPPER',
      'LOOKUP_HASH_KEY',
      'ENCRYPTION_KEYS',
      'ENCRYPTION_ACTIVE_KID',
      'METRICS_TOKEN',
      'FX_API_KEY',
    ]) {
      expect(names).toContain(required);
    }
    // FX_API_KEY adds how to do without it (decision 049).
    expect(issues.every((i) => i.message.startsWith('is required in production'))).toBe(true);
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

  describe('LOOKUP_HASH_KEY (decision 054)', () => {
    it('is required in production', () => {
      const env = production();
      delete env.LOOKUP_HASH_KEY;
      expect(issuesOf(env)).toEqual([{ variable: 'LOOKUP_HASH_KEY', message: 'is required in production' }]);
    });

    it('refuses the development pepper as the key in production', () => {
      expect(issuesOf({ ...production(), LOOKUP_HASH_KEY: DEV_DEFAULTS.tokenPepper })).toEqual([
        { variable: 'LOOKUP_HASH_KEY', message: 'must not use the development default in production' },
      ]);
    });

    it('refuses a key under 32 characters', () => {
      const issues = issuesOf({ ...production(), LOOKUP_HASH_KEY: 'short' });
      expect(issues.map((issue) => issue.variable)).toEqual(['LOOKUP_HASH_KEY']);
    });

    it('defaults to the pepper outside production, so existing rows keep matching', () => {
      const config = parseEnv({ NODE_ENV: 'development', TOKEN_PEPPER: 'q'.repeat(40) });
      expect(config.security.lookupHashKey).toBe('q'.repeat(40));
      expect(parseEnv({}).security.lookupHashKey).toBe(DEV_DEFAULTS.tokenPepper);
      expect(parseEnv({ LOOKUP_HASH_KEY: 'k'.repeat(40) }).security.lookupHashKey).toBe('k'.repeat(40));
    });

    it('is flagged, never shown, in the summary', () => {
      const summary = JSON.stringify(summarizeConfig(parseEnv(production())));
      expect(summary).toContain('"lookupHashKey":"[set]"');
      expect(summary).not.toContain('l'.repeat(40));
    });
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

describe('HTTP_*_TIMEOUT_MS (decision 053)', () => {
  it('defaults the request timeouts to 20 s and 600 s', () => {
    const { http } = parseEnv({});
    expect(http.headersTimeoutMs).toBe(20_000);
    expect(http.requestTimeoutMs).toBe(600_000);
  });

  it('reads the two settings', () => {
    const { http } = parseEnv({ HTTP_HEADERS_TIMEOUT_MS: '5000', HTTP_REQUEST_TIMEOUT_MS: '60000' });
    expect([http.headersTimeoutMs, http.requestTimeoutMs]).toEqual([5000, 60_000]);
  });

  it('has no bound on the silence of a connection: Bun would cut every live stream with it', () => {
    // Bun resets that timer only on bytes that come in, so a stream that only writes is cut at the bound. A value set by an old
    // environment is ignored, not applied.
    const { http } = parseEnv({ HTTP_IDLE_TIMEOUT_MS: '30000' });
    expect(Object.keys(http)).not.toContain('idleTimeoutMs');
    expect(issuesOf({ HTTP_IDLE_TIMEOUT_MS: '30000' })).toEqual([]);
  });

  it('refuses a headers timeout that is not shorter than the request timeout', () => {
    expect(issuesOf({ HTTP_HEADERS_TIMEOUT_MS: '30000', HTTP_REQUEST_TIMEOUT_MS: '30000' })).toEqual([
      { variable: 'HTTP_HEADERS_TIMEOUT_MS', message: 'must be shorter than HTTP_REQUEST_TIMEOUT_MS' },
    ]);
    expect(
      issuesOf({ HTTP_HEADERS_TIMEOUT_MS: '40000', HTTP_REQUEST_TIMEOUT_MS: '30000' }).map((i) => i.variable),
    ).toEqual(['HTTP_HEADERS_TIMEOUT_MS']);
    // The default headers bound (20 s) is longer than a request bound of 10 s.
    expect(issuesOf({ HTTP_REQUEST_TIMEOUT_MS: '10000' }).map((i) => i.variable)).toEqual(['HTTP_HEADERS_TIMEOUT_MS']);
    expect(issuesOf({ HTTP_HEADERS_TIMEOUT_MS: '29999', HTTP_REQUEST_TIMEOUT_MS: '30000' })).toEqual([]);
  });

  it('refuses values outside their ranges, naming the variable', () => {
    expect(issuesOf({ HTTP_HEADERS_TIMEOUT_MS: '99' }).map((i) => i.variable)).toEqual(['HTTP_HEADERS_TIMEOUT_MS']);
    expect(issuesOf({ HTTP_REQUEST_TIMEOUT_MS: '999' }).map((i) => i.variable)).toContain('HTTP_REQUEST_TIMEOUT_MS');
  });

  it('shows the two in the boot summary', () => {
    const http = summarizeConfig(parseEnv({ HTTP_HEADERS_TIMEOUT_MS: '5000' })).http as Record<string, unknown>;
    expect(http).toMatchObject({ headersTimeoutMs: 5000, requestTimeoutMs: 600_000 });
  });
});

describe('MAIL_* and TELEGRAM_* (decision 033)', () => {
  it('defaults to the Mailpit of compose.yaml outside production and leaves Telegram unset', () => {
    const config = parseEnv({});
    expect(config.mail).toEqual({
      smtpUrl: 'smtp://localhost:1025',
      from: 'IMEI-HUB <noreply@gsm.local>',
      requireTls: false,
    });
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

describe('ALERTS_* (feature 12b)', () => {
  it('is optional: no address and no chat by default, in production too', () => {
    expect(parseEnv({}).alerts).toEqual({ emailTo: [], telegramChatId: undefined });
    expect(parseEnv(production()).alerts).toEqual({ emailTo: [], telegramChatId: undefined });
  });

  it('reads a comma list of addresses (spaces and empty entries dropped, repeats removed) and the ops chat', () => {
    const config = parseEnv({
      ALERTS_EMAIL_TO: ' ops@example.com, Oncall@example.com ,, OPS@example.com ',
      ALERTS_TELEGRAM_CHAT_ID: '-1001234567890',
    });
    expect(config.alerts).toEqual({
      emailTo: ['ops@example.com', 'Oncall@example.com'],
      telegramChatId: '-1001234567890',
    });
    expect(parseEnv({ ALERTS_TELEGRAM_CHAT_ID: '@gsm_ops' }).alerts.telegramChatId).toBe('@gsm_ops');
  });

  it('stops the boot for an entry that is not an address or a chat, naming the variable and not echoing it', () => {
    expect(issuesOf({ ALERTS_EMAIL_TO: 'ops@example.com, Ops Team <ops@example.com>' }).map((i) => i.variable)).toEqual(
      ['ALERTS_EMAIL_TO'],
    );
    expect(issuesOf({ ALERTS_EMAIL_TO: 'not-an-address' }).map((i) => i.variable)).toEqual(['ALERTS_EMAIL_TO']);
    expect(issuesOf({ ALERTS_TELEGRAM_CHAT_ID: 'my chat' }).map((i) => i.variable)).toEqual([
      'ALERTS_TELEGRAM_CHAT_ID',
    ]);
    expect(JSON.stringify(issuesOf({ ALERTS_TELEGRAM_CHAT_ID: 'my chat' }))).not.toContain('my chat');
    expect(parseAlertEmails('a@b.co,')).toEqual({ ok: true, value: ['a@b.co'] });
  });

  it('keeps the addresses and the chat out of the boot summary, which only counts them', () => {
    const summary = summarizeConfig(
      parseEnv({ ALERTS_EMAIL_TO: 'ops@example.com', ALERTS_TELEGRAM_CHAT_ID: '-1001234567890' }),
    );
    expect(summary.alerts).toEqual({ emailRecipients: 1, telegramChat: '[set]' });
    expect(JSON.stringify(summary)).not.toContain('ops@example.com');
    expect(JSON.stringify(summary)).not.toContain('1001234567890');
  });
});

describe('METRICS_TOKEN', () => {
  it('is required in production, so a proxy without forwarding headers cannot expose /metrics', () => {
    const { METRICS_TOKEN: _unused, ...withoutToken } = production();
    expect(issuesOf(withoutToken)).toEqual([{ variable: 'METRICS_TOKEN', message: 'is required in production' }]);
    expect(parseEnv(production()).observability.metricsToken).toBe('metrics-token-for-prometheus-0123456');
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
    expect(parseEnv(production()).fx).toEqual({
      provider: 'openexchangerates',
      apiKey: 'fx-app-id-for-tests',
      timeoutMs: 5000,
    });
  });

  it('reads the provider, the key and the timeout', () => {
    const fx = parseEnv({ FX_PROVIDER: 'openexchangerates', FX_API_KEY: 'app-id-123', FX_TIMEOUT_MS: '2500' }).fx;
    expect(fx).toEqual({ provider: 'openexchangerates', apiKey: 'app-id-123', timeoutMs: 2500 });
    expect(parseEnv({ ...production(), FX_PROVIDER: 'manual' }).fx.provider).toBe('manual');
  });

  it('refuses openexchangerates without a key in production, naming FX_API_KEY and the way out (decision 049)', () => {
    const { FX_API_KEY: _unused, ...withoutKey } = production();
    for (const env of [withoutKey, { ...withoutKey, FX_PROVIDER: 'openexchangerates' }]) {
      const issues = issuesOf(env);
      expect(issues.map((issue) => issue.variable)).toEqual(['FX_API_KEY']);
      expect(issues[0]?.message).toContain('is required in production');
      expect(issues[0]?.message).toContain('FX_PROVIDER=manual');
    }
  });

  it('accepts FX_PROVIDER=manual without a key in production, and the key stays optional outside production', () => {
    const { FX_API_KEY: _unused, ...withoutKey } = production();
    expect(issuesOf({ ...withoutKey, FX_PROVIDER: 'manual' })).toEqual([]);
    expect(parseEnv({ ...withoutKey, FX_PROVIDER: 'manual' }).fx).toEqual({
      provider: 'manual',
      apiKey: undefined,
      timeoutMs: 5000,
    });
    expect(parseEnv({}).fx.provider).toBe('manual');
    expect(issuesOf({ FX_PROVIDER: 'openexchangerates' })).toEqual([]);
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
    expect(parseEnv({}).turnstile).toEqual({ secretKey: undefined, hostnames: [], merchantAuth: false });
  });

  it('turns the merchant sign-in check on by default in production only, and lets TURNSTILE_MERCHANT_AUTH set it either way (decision 052)', () => {
    expect(parseEnv(production()).turnstile.merchantAuth).toBe(true);
    expect(parseEnv({ ...production(), TURNSTILE_MERCHANT_AUTH: 'false' }).turnstile.merchantAuth).toBe(false);
    expect(parseEnv({ ...production(), TURNSTILE_MERCHANT_AUTH: 'true' }).turnstile.merchantAuth).toBe(true);
    expect(parseEnv({}).turnstile.merchantAuth).toBe(false);
    expect(parseEnv({ NODE_ENV: 'test' }).turnstile.merchantAuth).toBe(false);
    expect(parseEnv({ TURNSTILE_MERCHANT_AUTH: 'true' }).turnstile.merchantAuth).toBe(true);
    expect(parseEnv({ TURNSTILE_MERCHANT_AUTH: 'false' }).turnstile.merchantAuth).toBe(false);
    expect(issuesOf({ TURNSTILE_MERCHANT_AUTH: 'maybe' }).map((i) => i.variable)).toEqual(['TURNSTILE_MERCHANT_AUTH']);
    expect(JSON.stringify(summarizeConfig(parseEnv({ TURNSTILE_MERCHANT_AUTH: 'true' })))).toContain(
      '"merchantAuth":true',
    );
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

describe('REALTIME_* (decision 037)', () => {
  it('defaults to streams on, 5000 per process, 3 per session, 30 per address, a 15 s heartbeat and 15 minutes', () => {
    expect(parseEnv({}).realtime).toEqual({
      enabled: true,
      maxConnections: 5000,
      maxPerSession: 3,
      maxPerIp: 30,
      heartbeatSeconds: 15,
      maxAgeSeconds: 900,
    });
    expect(parseEnv(production()).realtime.enabled).toBe(true);
  });

  it('reads the kill switch and the limits', () => {
    const config = parseEnv({
      REALTIME_ENABLED: 'false',
      REALTIME_MAX_CONNECTIONS: '100',
      REALTIME_MAX_PER_SESSION: '2',
      REALTIME_MAX_PER_IP: '5000',
      REALTIME_HEARTBEAT_SECONDS: '5',
      REALTIME_MAX_AGE_SECONDS: '60',
    });
    expect(config.realtime).toEqual({
      enabled: false,
      maxConnections: 100,
      maxPerSession: 2,
      maxPerIp: 5000,
      heartbeatSeconds: 5,
      maxAgeSeconds: 60,
    });
    expect(JSON.stringify(summarizeConfig(config))).toContain('"realtime":{"enabled":false');
  });

  it('keeps the heartbeat under the 30 s cut of a Next rewrite and the age between a minute and an hour', () => {
    for (const [variable, value] of [
      ['REALTIME_HEARTBEAT_SECONDS', '4'],
      ['REALTIME_HEARTBEAT_SECONDS', '26'],
      ['REALTIME_MAX_AGE_SECONDS', '59'],
      ['REALTIME_MAX_AGE_SECONDS', '3601'],
      ['REALTIME_MAX_PER_SESSION', '0'],
      ['REALTIME_MAX_CONNECTIONS', 'many'],
      ['REALTIME_ENABLED', 'maybe'],
    ] as const) {
      expect(issuesOf({ [variable]: value }).map((i) => i.variable)).toEqual([variable]);
    }
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

describe('DATABASE_*_TIMEOUT_MS (decision 055)', () => {
  it('reads the three database time limits, defaults to 15 s, 5 s and 60 s, and to none under NODE_ENV=test', () => {
    expect(parseEnv({}).database.timeouts).toEqual({ statementMs: 15_000, lockMs: 5_000, idleInTransactionMs: 60_000 });
    expect(parseEnv(production()).database.timeouts).toEqual({
      statementMs: 15_000,
      lockMs: 5_000,
      idleInTransactionMs: 60_000,
    });
    expect(parseEnv({ NODE_ENV: 'test' }).database.timeouts).toEqual({
      statementMs: 0,
      lockMs: 0,
      idleInTransactionMs: 0,
    });
    expect(
      parseEnv({
        DATABASE_STATEMENT_TIMEOUT_MS: '300000',
        DATABASE_LOCK_TIMEOUT_MS: '30000',
        DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '120000',
      }).database.timeouts,
    ).toEqual({ statementMs: 300_000, lockMs: 30_000, idleInTransactionMs: 120_000 });
    // A limit test sets its own under NODE_ENV=test.
    expect(parseEnv({ NODE_ENV: 'test', DATABASE_LOCK_TIMEOUT_MS: '1200' }).database.timeouts.lockMs).toBe(1_200);
  });

  it('refuses a limit between 1 and 999 ms and accepts 0', () => {
    const message = 'must be 0 (no limit) or at least 1000 milliseconds';
    expect(
      issuesOf({
        DATABASE_STATEMENT_TIMEOUT_MS: '500',
        DATABASE_LOCK_TIMEOUT_MS: '1',
        DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '999',
      }),
    ).toEqual([
      { variable: 'DATABASE_STATEMENT_TIMEOUT_MS', message },
      { variable: 'DATABASE_LOCK_TIMEOUT_MS', message },
      { variable: 'DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS', message },
    ]);
    expect(
      parseEnv({
        DATABASE_STATEMENT_TIMEOUT_MS: '0',
        DATABASE_LOCK_TIMEOUT_MS: '0',
        DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '1000',
      }).database.timeouts,
    ).toEqual({ statementMs: 0, lockMs: 0, idleInTransactionMs: 1_000 });
    expect(issuesOf({ DATABASE_LOCK_TIMEOUT_MS: '600001' }).map((issue) => issue.variable)).toEqual([
      'DATABASE_LOCK_TIMEOUT_MS',
    ]);
  });

  it('shows the limits in the boot summary', () => {
    const summary = summarizeConfig(parseEnv({ DATABASE_STATEMENT_TIMEOUT_MS: '20000' })) as {
      database: { timeouts: unknown };
    };
    expect(summary.database.timeouts).toEqual({ statementMs: 20_000, lockMs: 5_000, idleInTransactionMs: 60_000 });
  });
});

describe('summarizeConfig', () => {
  it('never contains secrets, passwords or key material', () => {
    const config = parseEnv({
      ...production(),
      METRICS_TOKEN: 'metrics-token-1234567890-abcdefgh',
      SENTRY_DSN: 'https://public@sentry.example.com/1',
      PROMETHEUS_URL: 'http://user:promPassword@prometheus.internal:9090',
    });
    const text = JSON.stringify(summarizeConfig(config));
    for (const secret of [
      SECRET,
      KEY,
      'app-password-0123456789',
      'queue-password-0123456789',
      'cache-password-0123456789',
      'secret-access-key',
      'AKIA-ID',
      'metrics-token-1234567890-abcdefgh',
      'promPassword',
      'public@sentry',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('postgres://app:***@db.internal:5432/gsm');
    expect(text).toContain('"encryptionKeyIds":["k1"]');
    expect(text).toContain('"metricsToken":"[set]"');
  });

  it('shows the origin lists of the two audiences and no corsOrigins (decision 045)', () => {
    const summary = summarizeConfig(parseEnv(production())) as { http: Record<string, unknown> };
    expect(summary.http.consoleOrigins).toEqual(['https://admin.gsm.example']);
    expect(summary.http.shopOrigins).toEqual(['https://shop.gsm.example', 'https://portal.gsm.example']);
    expect(summary.http).not.toHaveProperty('corsOrigins');
  });
});

describe('.env.example', () => {
  const text = readFileSync(join(import.meta.dir, '../../../.env.example'), 'utf8');
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

describe('search (feature 29)', () => {
  it('is on in development with the compose node and its bootstrap key for both processes, and off under test', () => {
    const development = parseEnv({});
    expect(development.search).toEqual({
      enabled: true,
      url: DEV_DEFAULTS.typesenseUrl,
      indexerKey: DEV_DEFAULTS.typesenseKey,
      searchKey: DEV_DEFAULTS.typesenseKey,
      prefix: 'gsm_development_',
      suggestTimeoutMs: 250,
      timeoutMs: 800,
      reconcileMinutes: 15,
    });
    const test = parseEnv({ NODE_ENV: 'test' });
    expect(test.search.enabled).toBe(false);
    expect(test.search.prefix).toBe('gsm_test_');
  });

  it('reads only the *_TEST values under test, and derives the prefix from the test database name', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      SEARCH_ENABLED: 'false',
      SEARCH_ENABLED_TEST: 'true',
      TYPESENSE_URL: 'http://never:1',
      TYPESENSE_URL_TEST: 'http://127.0.0.1:8108/',
      TYPESENSE_PREFIX: 'gsm_other_',
      DATABASE_URL_TEST: 'postgres://gsm:gsm@localhost:5432/gsm_29_test',
    });
    expect(config.search.enabled).toBe(true);
    expect(config.search.url).toBe('http://127.0.0.1:8108');
    expect(config.search.prefix).toBe('gsm_29_test_');
    expect(parseEnv({ NODE_ENV: 'test', TYPESENSE_PREFIX_TEST: 'gsm_29_test_ab12_' }).search.prefix).toBe(
      'gsm_29_test_ab12_',
    );
    expect(searchPrefixOf('postgres://gsm:gsm@localhost:5432/Gsm-Lock.Test')).toBe('gsm_lock_test_');
  });

  it('refuses a prefix that breaks the naming rule and timeouts outside their ranges', () => {
    const issues = issuesOf({
      TYPESENSE_PREFIX: 'Bad-Prefix',
      SEARCH_SUGGEST_TIMEOUT_MS: '10',
      SEARCH_TIMEOUT_MS: '9000',
      SEARCH_RECONCILE_MINUTES: '1',
    });
    expect(issues.map((issue) => issue.variable).sort()).toEqual([
      'SEARCH_RECONCILE_MINUTES',
      'SEARCH_SUGGEST_TIMEOUT_MS',
      'SEARCH_TIMEOUT_MS',
      'TYPESENSE_PREFIX',
    ]);
  });

  it('requires TYPESENSE_URL in production while search is on, never defaults a key there, and refuses the development key', () => {
    const { TYPESENSE_URL: _url, ...withoutUrl } = production();
    expect(issuesOf(withoutUrl)).toEqual([{ variable: 'TYPESENSE_URL', message: 'is required in production' }]);
    expect(issuesOf({ ...withoutUrl, SEARCH_ENABLED: 'false' })).toEqual([]);
    const config = parseEnv(production());
    expect(config.search).toMatchObject({
      enabled: true,
      url: 'http://typesense:8108',
      indexerKey: undefined,
      searchKey: undefined,
      prefix: 'gsm_production_',
    });
    expect(
      issuesOf({ ...production(), TYPESENSE_SEARCH_KEY: DEV_DEFAULTS.typesenseKey }).map((issue) => issue.variable),
    ).toEqual(['TYPESENSE_SEARCH_KEY']);
    expect(
      issuesOf({ ...production(), TYPESENSE_INDEXER_KEY: DEV_DEFAULTS.typesenseKey }).map((issue) => issue.variable),
    ).toEqual(['TYPESENSE_INDEXER_KEY']);
  });

  it('never prints the keys in the boot summary', () => {
    const config = parseEnv({
      ...production(),
      TYPESENSE_SEARCH_KEY: 'search-key-secret-0123456789abcdef',
      TYPESENSE_INDEXER_KEY: 'idx-secret-0123456789abcdefghijkl',
    });
    const text = JSON.stringify(summarizeConfig(config));
    expect(text).not.toContain('search-key-secret');
    expect(text).not.toContain('idx-secret');
    expect(text).toContain('"searchKey":"[set]"');
  });
});

describe('the production stack and its configuration (decision 055)', () => {
  const NO_DEV = 'must not use the development default in production';

  describe('a process without NODE_ENV', () => {
    it('refuses a database that is not on this machine', () => {
      expect(issuesOf({ DATABASE_URL: 'postgres://u:p@db.example.com:5432/x' })).toEqual([
        { variable: 'NODE_ENV', message: NODE_ENV_REMOTE_REFUSED },
      ]);
      // A host named outside the authority counts too.
      expect(issuesOf({ DATABASE_URL: 'postgres://u:p@localhost:5432/x?host=db.example.com' })).toEqual([
        { variable: 'NODE_ENV', message: NODE_ENV_REMOTE_REFUSED },
      ]);
      expect(issuesOf({ DATABASE_URL: 'postgres://u:p@localhost:5432/x?hostaddr=10.0.0.5' })).toEqual([
        { variable: 'NODE_ENV', message: NODE_ENV_REMOTE_REFUSED },
      ]);
    });

    it('accepts localhost, a loopback address, an IPv6 loopback and a socket directory, and the default', () => {
      for (const url of [
        'postgres://u:p@localhost:5432/x',
        'postgres://u:p@127.0.0.5:5432/x',
        'postgres://u:p@[::1]:5432/x',
        'postgres://u:p@localhost/x?host=/var/run/postgresql',
      ]) {
        expect(issuesOf({ DATABASE_URL: url }), url).toEqual([]);
      }
      expect(issuesOf({})).toEqual([]);
    });

    it('judges the host of PGHOST when the URL names none, because the driver connects there', () => {
      const withoutHost = 'postgres:///x?user=u&password=p';
      // No host in the URL and no PGHOST: the driver's default, this machine.
      expect(issuesOf({ DATABASE_URL: withoutHost })).toEqual([]);
      expect(issuesOf({ DATABASE_URL: withoutHost, PGHOST: 'localhost' })).toEqual([]);
      expect(issuesOf({ DATABASE_URL: withoutHost, PGHOST: '/var/run/postgresql' })).toEqual([]);
      // A remote PGHOST makes the database remote.
      expect(issuesOf({ DATABASE_URL: withoutHost, PGHOST: 'db.example.com' })).toEqual([
        { variable: 'NODE_ENV', message: NODE_ENV_REMOTE_REFUSED },
      ]);
      expect(issuesOf({ DATABASE_URL: withoutHost, PGHOST: 'localhost,db.example.com' })).toEqual([
        { variable: 'NODE_ENV', message: NODE_ENV_REMOTE_REFUSED },
      ]);
      // No DATABASE_URL at all is the development default (a host of its own), which PGHOST does not replace.
      expect(issuesOf({ PGHOST: 'db.example.com' })).toEqual([]);
      // A URL that names its host is not changed by PGHOST.
      expect(issuesOf({ DATABASE_URL: 'postgres://u:p@localhost:5432/x', PGHOST: 'db.example.com' })).toEqual([]);
      expect(parseEnv({ DATABASE_URL: withoutHost, PGHOST: 'localhost' }).database.driverHost).toBe('localhost');
      expect(parseEnv({}).database.driverHost).toBeUndefined();
    });

    it('does not apply once the mode is named, and leaves an unreadable URL to its own variable', () => {
      const remote = 'postgres://u:p@db.example.com:5432/x';
      expect(issuesOf({ NODE_ENV: 'development', DATABASE_URL: remote })).toEqual([]);
      expect(issuesOf({ NODE_ENV: 'test', DATABASE_URL: remote })).toEqual([]);
      expect(issuesOf({ DATABASE_URL: 'not a url' }).map((issue) => issue.variable)).toEqual(['DATABASE_URL']);
    });
  });

  describe('the password rule and PGHOST', () => {
    it('applies to a database URL without a host when PGHOST is another machine, and not otherwise', () => {
      const withoutHost = 'postgres:///gsm?user=gsm_app&password=short';
      const weak = [{ variable: 'DATABASE_URL', message: WEAK_PASSWORD_REFUSED }];
      expect(issuesOf({ ...production(), DATABASE_URL: withoutHost })).toEqual([]);
      expect(issuesOf({ ...production(), DATABASE_URL: withoutHost, PGHOST: 'localhost' })).toEqual([]);
      expect(issuesOf({ ...production(), DATABASE_URL: withoutHost, PGHOST: 'db.internal' })).toEqual(weak);
      expect(issuesOf({ ...production(), DATABASE_OWNER_URL: withoutHost, PGHOST: 'db.internal' })).toEqual([
        { variable: 'DATABASE_OWNER_URL', message: WEAK_PASSWORD_REFUSED },
      ]);
    });
  });

  describe('isLocalHost and databaseIsLocal', () => {
    it('knows the hosts of this machine', () => {
      for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.9.9.9', '[::1]', '::1']) {
        expect(isLocalHost(host), host).toBe(true);
      }
      for (const host of ['db.example.com', '10.0.0.5', '128.0.0.1', '127.0.0', 'localhost.example.com', '']) {
        expect(isLocalHost(host), host).toBe(false);
      }
    });

    it('reads every host of a connection URL', () => {
      expect(databaseIsLocal('postgres://u:p@localhost/x')).toBe(true);
      expect(databaseIsLocal('postgres://u:p@/x?host=/tmp')).toBe(true);
      expect(databaseIsLocal('postgres://u:p@localhost/x?host=localhost,db.example.com')).toBe(false);
      expect(databaseIsLocal('postgres://u:p@db.example.com/x')).toBe(false);
      expect(databaseIsLocal('redis://:p@queue.internal:6379/0')).toBe(false);
      expect(databaseIsLocal('not a url')).toBe(true);
    });

    it('does not take an empty host as local by itself: the driver then connects to PGHOST', () => {
      const empty = 'postgres:///x?user=u';
      expect(databaseIsLocal(empty)).toBe(true); // no PGHOST: the driver's default is this machine
      expect(databaseIsLocal(empty, '')).toBe(true);
      expect(databaseIsLocal(empty, 'localhost')).toBe(true);
      expect(databaseIsLocal(empty, '127.0.0.1')).toBe(true);
      expect(databaseIsLocal(empty, '/var/run/postgresql')).toBe(true);
      expect(databaseIsLocal(empty, 'db.example.com')).toBe(false);
      expect(databaseIsLocal(empty, '10.0.0.5')).toBe(false);
      expect(databaseIsLocal(empty, 'localhost, db.example.com')).toBe(false);
      // A host the URL names itself (in the authority or in ?host=) is the one the driver uses, so PGHOST does not count.
      expect(databaseIsLocal('postgres://localhost/x', 'db.example.com')).toBe(true);
      expect(databaseIsLocal('postgres:///x?host=/tmp', 'db.example.com')).toBe(true);
      expect(databaseIsLocal('postgres:///x?host=localhost', 'db.example.com')).toBe(true);
      // A remote host of the URL stays remote whatever PGHOST says.
      expect(databaseIsLocal('postgres://db.example.com/x', 'localhost')).toBe(false);
      // hostaddr is no host of its own for the driver: with PGHOST remote the database is remote, and a remote hostaddr always counts.
      expect(databaseIsLocal('postgres:///x?hostaddr=127.0.0.1', 'db.example.com')).toBe(false);
      expect(databaseIsLocal('postgres:///x?hostaddr=10.0.0.5', 'localhost')).toBe(false);
    });
  });

  describe('placeholders', () => {
    it('are refused in any variable in production, by name, with the same message', () => {
      for (const [variable, value] of [
        ['TURNSTILE_SECRET_KEY', 'CHANGE_ME_TURNSTILE_SECRET'],
        ['MAIL_SMTP_URL', 'smtps://CHANGE_ME_SMTP_USER:CHANGE_ME_SMTP_PASSWORD@smtp.provider.example:465'],
        ['DATABASE_URL', 'postgres://gsm_app:CHANGE_ME_APP_DB_PASSWORD@db.internal:5432/gsm'],
        ['REDIS_QUEUE_URL', 'redis://:CHANGE_ME_REDIS_QUEUE_PASSWORD@queue.internal:6379/0'],
        ['ENCRYPTION_KEYS', 'CHANGE_ME_ENCRYPTION_KEYS'],
        ['S3_ACCESS_KEY_ID', 'CHANGE_ME_MINIO_APP_USER'],
        ['LOOKUP_HASH_KEY', 'CHANGE_ME_LOOKUP_HASH_KEY_0123456789abcdef'],
        ['FX_API_KEY', 'CHANGE_ME_FX_API_KEY'],
      ] as const) {
        expect(issuesOf({ ...production(), [variable]: value }), variable).toEqual([
          { variable, message: PLACEHOLDER_REFUSED },
        ]);
      }
    });

    it('are named even when another rule would refuse the value too (a short secret)', () => {
      expect(
        issuesOf({ ...production(), CSRF_SECRET: 'CHANGE_ME_CSRF_SECRET' }).map((issue) => issue.variable),
      ).toEqual(['CSRF_SECRET']);
      expect(issuesOf({ ...production(), METRICS_TOKEN: 'CHANGE_ME_METRICS_TOKEN' })).toEqual([
        { variable: 'METRICS_TOKEN', message: PLACEHOLDER_REFUSED },
      ]);
    });

    it('are not a problem outside production', () => {
      expect(issuesOf({ TURNSTILE_SECRET_KEY: 'CHANGE_ME_TURNSTILE_SECRET' })).toEqual([]);
    });
  });

  describe('short secrets and weak passwords', () => {
    const tooShort = (variable: string, min: number) => ({
      variable,
      message: `must be at least ${min} characters in production`,
    });

    it('refuses a metrics token, a search key or an S3 secret under its minimum, and accepts the minimum', () => {
      expect(issuesOf({ ...production(), METRICS_TOKEN: 'm'.repeat(31) })).toEqual([tooShort('METRICS_TOKEN', 32)]);
      expect(issuesOf({ ...production(), METRICS_TOKEN: 'm'.repeat(32) })).toEqual([]);
      expect(issuesOf({ ...production(), TYPESENSE_SEARCH_KEY: 's'.repeat(31) })).toEqual([
        tooShort('TYPESENSE_SEARCH_KEY', 32),
      ]);
      expect(issuesOf({ ...production(), TYPESENSE_INDEXER_KEY: 'i'.repeat(31) })).toEqual([
        tooShort('TYPESENSE_INDEXER_KEY', 32),
      ]);
      expect(
        issuesOf({ ...production(), TYPESENSE_SEARCH_KEY: 's'.repeat(32), TYPESENSE_INDEXER_KEY: 'i'.repeat(32) }),
      ).toEqual([]);
      expect(issuesOf({ ...production(), S3_SECRET_ACCESS_KEY: 'k'.repeat(15) })).toEqual([
        tooShort('S3_SECRET_ACCESS_KEY', 16),
      ]);
      expect(issuesOf({ ...production(), S3_SECRET_ACCESS_KEY: 'k'.repeat(16) })).toEqual([]);
    });

    it('refuses a service on another machine without a password or with a short one', () => {
      const weak = (variable: string) => [{ variable, message: WEAK_PASSWORD_REFUSED }];
      expect(issuesOf({ ...production(), REDIS_QUEUE_URL: 'redis://queue.internal:6379/0' })).toEqual(
        weak('REDIS_QUEUE_URL'),
      );
      expect(
        issuesOf({ ...production(), REDIS_CACHE_URL: `redis://:${'c'.repeat(15)}@cache.internal:6379/0` }),
      ).toEqual(weak('REDIS_CACHE_URL'));
      expect(issuesOf({ ...production(), DATABASE_URL: 'postgres://app@db.internal:5432/gsm' })).toEqual(
        weak('DATABASE_URL'),
      );
      expect(
        issuesOf({ ...production(), DATABASE_OWNER_URL: `postgres://gsm:${'o'.repeat(15)}@db.internal:5432/gsm` }),
      ).toEqual(weak('DATABASE_OWNER_URL'));
      expect(
        issuesOf({ ...production(), DATABASE_OWNER_URL: `postgres://gsm:${'o'.repeat(16)}@db.internal:5432/gsm` }),
      ).toEqual([]);
      // The length is the length of the password, not of its percent-encoded text.
      expect(
        issuesOf({ ...production(), REDIS_QUEUE_URL: `redis://:${'q'.repeat(15)}%41@queue.internal:6379/0` }),
      ).toEqual([]);
    });

    it('accepts the same values on this machine (the production rules of the tests run against local instances)', () => {
      expect(
        issuesOf({
          ...production(),
          DATABASE_URL: 'postgres://app:pw@localhost:5432/gsm',
          REDIS_QUEUE_URL: 'redis://127.0.0.1:6391/14',
          REDIS_CACHE_URL: 'redis://localhost:6392/14',
        }),
      ).toEqual([]);
    });
  });

  describe('the development values', () => {
    it('are refused in production for the database, both Redis URLs, the S3 key pair and the mail URL', () => {
      for (const [variable, value] of [
        ['DATABASE_URL', DEV_DEFAULTS.databaseUrl],
        ['REDIS_QUEUE_URL', DEV_DEFAULTS.redisQueueUrl],
        ['REDIS_CACHE_URL', DEV_DEFAULTS.redisCacheUrl],
        ['S3_ACCESS_KEY_ID', DEV_DEFAULTS.s3AccessKeyId],
        ['S3_SECRET_ACCESS_KEY', DEV_DEFAULTS.s3SecretAccessKey],
        ['MAIL_SMTP_URL', DEV_DEFAULTS.mailSmtpUrl],
      ] as const) {
        expect(issuesOf({ ...production(), [variable]: value }), variable).toEqual([{ variable, message: NO_DEV }]);
      }
    });
  });

  describe('TRUST_PROXY', () => {
    it('is required in production, and an explicit false is accepted', () => {
      const { TRUST_PROXY: _unused, ...without } = production();
      expect(issuesOf(without)).toEqual([{ variable: 'TRUST_PROXY', message: 'is required in production' }]);
      const config = parseEnv({ ...production(), TRUST_PROXY: 'false' });
      expect(config.http.trustProxy).toBe(false);
      expect(config.warnings).toEqual([]);
    });

    it('warns once about a range, a named range or a hop count, and not about exact addresses', () => {
      for (const value of ['172.30.0.0/24', '2', 'loopback', '172.30.1.2, 10.0.0.0/8', 'fd00::/8']) {
        expect(parseEnv({ ...production(), TRUST_PROXY: value }).warnings, value).toEqual([
          { variable: 'TRUST_PROXY', message: TRUST_PROXY_RANGE_WARNING },
        ]);
      }
      for (const value of ['172.30.1.2,172.30.1.3', '172.30.1.2/32', '::1', 'fd00::1/128']) {
        expect(parseEnv({ ...production(), TRUST_PROXY: value }).warnings, value).toEqual([]);
      }
      expect(parseEnv(production()).warnings).toEqual([]);
    });

    it('reads a value the way trustProxyIsRange says', () => {
      expect(trustProxyIsRange(false)).toBe(false);
      expect(trustProxyIsRange(1)).toBe(true);
      expect(trustProxyIsRange(['loopback'])).toBe(true);
      expect(trustProxyIsRange(['10.0.0.0/8'])).toBe(true);
      expect(trustProxyIsRange(['10.0.0.1', '10.0.0.2/32'])).toBe(false);
    });
  });

  describe('argon2', () => {
    const floor = (memory: string, passes: string) => ({
      ...production(),
      ARGON2_MEMORY_KIB: memory,
      ARGON2_TIME_COST: passes,
    });

    // The published pairs (memory in KiB, passes), and for each one the settings just below it on either axis.
    const PAIRS = [
      [47_104, 1],
      [19_456, 2],
      [12_288, 3],
      [9_216, 4],
      [7_168, 5],
    ] as const;

    it('is refused in production below the OWASP minimum', () => {
      for (const [memory, passes] of [
        ['19456', '1'],
        ['8', '20'],
        ['7167', '20'],
        // The old product rule let these through: enough memory times passes, but no published pair.
        ['12000', '3'],
        ['30000', '1'],
        ['10000', '3'],
      ] as const) {
        expect(issuesOf(floor(memory, passes)), `${memory}/${passes}`).toEqual([
          { variable: 'ARGON2_MEMORY_KIB', message: ARGON2_FLOOR_REFUSED },
        ]);
      }
    });

    it('accepts each OWASP setting, and development accepts a cheap one', () => {
      for (const [memory, passes] of [
        ['19456', '2'],
        ['47104', '1'],
        ['7168', '5'],
        ['12288', '3'],
        ['9216', '4'],
      ] as const) {
        expect(issuesOf(floor(memory, passes)), `${memory}/${passes}`).toEqual([]);
      }
      expect(issuesOf({ ARGON2_MEMORY_KIB: '8', ARGON2_TIME_COST: '1' })).toEqual([]);
    });

    it('passes exactly on a pair, or on more memory and more passes than a pair, and on neither side of it alone', () => {
      for (const [memory, passes] of PAIRS) {
        expect(argon2MeetsFloor(memory, passes), `${memory}/${passes}`).toBe(true);
        expect(argon2MeetsFloor(memory + 1, passes), `${memory + 1}/${passes}`).toBe(true);
        expect(argon2MeetsFloor(memory, passes + 1), `${memory}/${passes + 1}`).toBe(true);
        expect(argon2MeetsFloor(memory + 10_000, passes + 3), `${memory + 10_000}/${passes + 3}`).toBe(true);
      }
      // One KiB of memory short of a pair fails unless a cheaper pair with more passes is met.
      expect(argon2MeetsFloor(47_103, 1)).toBe(false);
      expect(argon2MeetsFloor(19_455, 2)).toBe(false);
      expect(argon2MeetsFloor(12_287, 3)).toBe(false);
      expect(argon2MeetsFloor(9_215, 4)).toBe(false);
      expect(argon2MeetsFloor(7_167, 5)).toBe(false);
      // One pass short of a pair fails unless a pair with fewer passes is met by the memory.
      expect(argon2MeetsFloor(47_103, 5)).toBe(true); // 19456/2 and the others are met
      expect(argon2MeetsFloor(19_456, 1)).toBe(false);
      expect(argon2MeetsFloor(12_288, 2)).toBe(false);
      expect(argon2MeetsFloor(9_216, 3)).toBe(false);
      expect(argon2MeetsFloor(7_168, 4)).toBe(false);
      // More of one axis does not make up for the other.
      expect(argon2MeetsFloor(47_103, 1)).toBe(false);
      expect(argon2MeetsFloor(7_167, 1_000)).toBe(false);
      expect(argon2MeetsFloor(1_000_000, 0)).toBe(false);
    });
  });

  describe('DATABASE_OWNER_URL and S3_PUBLIC_ENDPOINT', () => {
    const OWNER = 'postgres://gsm:owner-password-0123456789@db.internal:5432/gsm';

    it('reads the owner URL, ignores it under test, and shows only that it is set', () => {
      expect(parseEnv({ ...production(), DATABASE_OWNER_URL: OWNER }).database.ownerUrl).toBe(OWNER);
      expect(parseEnv(production()).database.ownerUrl).toBeUndefined();
      expect(parseEnv({ NODE_ENV: 'test', DATABASE_OWNER_URL: OWNER }).database.ownerUrl).toBeUndefined();
      const text = JSON.stringify(summarizeConfig(parseEnv({ ...production(), DATABASE_OWNER_URL: OWNER })));
      expect(text).toContain('"ownerUrl":"[set]"');
      expect(text).not.toContain('owner-password-0123456789');
    });

    it('reads the public endpoint without a trailing slash, requires https in production and shows it redacted', () => {
      const config = parseEnv({ ...production(), S3_PUBLIC_ENDPOINT: 'https://files.gsm.example//' });
      expect(config.s3.publicEndpoint).toBe('https://files.gsm.example');
      expect(JSON.stringify(summarizeConfig(config))).toContain('"publicEndpoint":"https://files.gsm.example/"');
      expect(issuesOf({ ...production(), S3_PUBLIC_ENDPOINT: 'http://files.gsm.example' })).toEqual([
        { variable: 'S3_PUBLIC_ENDPOINT', message: 'must be an https URL in production' },
      ]);
      expect(parseEnv({ S3_PUBLIC_ENDPOINT: 'http://localhost:9000' }).s3.publicEndpoint).toBe('http://localhost:9000');
      expect(parseEnv({}).s3.publicEndpoint).toBeUndefined();
    });

    it('accepts a plain-http store only inside the stack: one label or loopback, and refuses every other host, IPv6 literals included', () => {
      const refused = {
        variable: 'S3_ENDPOINT',
        message: 'must be an https URL in production when the store is not on the private network',
      };
      for (const endpoint of [
        'http://s3.provider.example:9000',
        'http://10.0.0.5:9000',
        'http://172.30.2.7:9000',
        'http://[fd00::1]:9000',
        'http://[2001:db8::5]:9000',
        'http://[fe80::1]:9000',
        'http://[::ffff:10.0.0.5]:9000',
        'http://minio.:9000',
        'http://0x0a000005:9000', // written in hexadecimal, it is 10.0.0.5
        'http://2130706433.example:9000',
      ]) {
        expect(issuesOf({ ...production(), S3_ENDPOINT: endpoint }), endpoint).toEqual([refused]);
      }
      for (const endpoint of [
        'http://minio:9000',
        'http://minio',
        'http://gsm-minio_1:9000',
        'http://localhost:9000',
        'http://127.0.0.1:9000',
        'http://127.4.5.6:9000',
        'http://[::1]:9000',
      ]) {
        expect(issuesOf({ ...production(), S3_ENDPOINT: endpoint }), endpoint).toEqual([]);
      }
    });

    it('knows a host inside the stack', () => {
      for (const host of ['minio', 'MinIO', 'gsm-minio_1', 'a', 'localhost', '127.0.0.1', '[::1]', '::1']) {
        expect(isStackHost(host), host).toBe(true);
      }
      for (const host of [
        '',
        'minio.',
        'minio.internal',
        '10.0.0.5',
        '[fd00::1]',
        '[::ffff:7f00:1]',
        '-minio',
        'mi nio',
        'minio:9000',
      ]) {
        expect(isStackHost(host), host).toBe(false);
      }
    });

    it('refuses a plain-http store with a public host name, and warns when links cannot be signed for a browser', () => {
      const warning = (config: ReturnType<typeof parseEnv>) => config.warnings.map((entry) => entry.variable);
      expect(issuesOf({ ...production(), S3_ENDPOINT: 'http://s3.provider.example:9000' })).toEqual([
        {
          variable: 'S3_ENDPOINT',
          message: 'must be an https URL in production when the store is not on the private network',
        },
      ]);
      expect(issuesOf({ ...production(), S3_ENDPOINT: 'https://s3.provider.example' })).toEqual([]);
      // The bundled store has a name without a dot (or is on this machine): accepted, with the warning while no public endpoint is set.
      for (const endpoint of ['http://minio:9000', 'http://localhost:9000', 'http://127.0.0.1:9000']) {
        expect(warning(parseEnv({ ...production(), S3_ENDPOINT: endpoint })), endpoint).toEqual(['S3_PUBLIC_ENDPOINT']);
      }
      expect(
        parseEnv({ ...production(), S3_ENDPOINT: 'http://minio:9000', S3_PUBLIC_ENDPOINT: 'https://files.gsm.example' })
          .warnings,
      ).toEqual([]);
      expect(parseEnv({ ...production(), S3_ENDPOINT: 'https://s3.provider.example' }).warnings).toEqual([]);
    });
  });

  it('requires TLS for mail in production only', () => {
    expect(parseEnv(production()).mail.requireTls).toBe(true);
    expect(parseEnv({ NODE_ENV: 'development' }).mail.requireTls).toBe(false);
    expect(parseEnv({ NODE_ENV: 'test' }).mail.requireTls).toBe(false);
    expect(JSON.stringify(summarizeConfig(parseEnv(production())))).toContain('"requireTls":true');
  });
});
