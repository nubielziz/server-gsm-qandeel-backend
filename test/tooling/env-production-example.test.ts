// Keeps the production env templates (feature 24D, decision 036) complete, consistent and free of development secrets:
// `.env.production.example` (the application's variables) and `deploy/.env.example` (the compose-level values).
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ConfigError, DEV_DEFAULTS, ENV_VARIABLES, parseEnv, parseTrustProxy } from '@src/config';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), 'utf8');

/** The active `KEY=value` lines of an env template, with the trailing `# comment` removed. */
function activeVariables(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    out[match[1] as string] = (match[2] as string).replace(/\s+#.*$/, '').trim();
  }
  return out;
}

/** The names mentioned by the optional section (`# NAME=`) of the production template. */
function commentedVariables(text: string): string[] {
  return [...text.matchAll(/^# ([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] as string);
}

/** The problems `parseEnv` finds in an environment (empty when it is valid). */
function issuesOf(env: Record<string, string>): { variable: string; message: string }[] {
  try {
    parseEnv(env);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.issues];
    throw error;
  }
  return [];
}

const production = read('.env.production.example');
const productionVars = activeVariables(production);
const deploy = activeVariables(read('deploy/.env.example'));

describe('.env.production.example', () => {
  it('carries every variable that .env.example marks REQUIRED in production', () => {
    const required = read('.env.example')
      .split('\n')
      .filter((line) => line.includes('REQUIRED in production'))
      .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    expect(required.length).toBeGreaterThanOrEqual(17);
    const known = new Set([...Object.keys(productionVars), ...commentedVariables(production)]);
    // S3_BUCKET etc. are in the active part; the test-only and optional ones are not required.
    expect(required.filter((name) => productionVars[name] === undefined)).toEqual([]);
    expect(known.size).toBeGreaterThan(required.length);
  });

  it('only names variables that src/config/env.ts reads (and none the image sets)', () => {
    const names = [...Object.keys(productionVars), ...commentedVariables(production)];
    const unknown = names.filter((name) => !ENV_VARIABLES.includes(name));
    expect(unknown).toEqual([]);
    for (const imageSet of ['PORT', 'APP_VERSION', 'GIT_SHA']) expect(names).not.toContain(imageSet);
  });

  it('holds no development secret or default', () => {
    const forbidden = [
      DEV_DEFAULTS.csrfSecret,
      DEV_DEFAULTS.tokenPepper,
      DEV_DEFAULTS.encryptionKey,
      DEV_DEFAULTS.s3SecretAccessKey,
    ];
    for (const text of [production, read('deploy/.env.example')]) {
      for (const secret of forbidden) expect(text).not.toContain(secret);
      expect(text).not.toContain('gsm-minio');
      expect(text).not.toContain('localhost');
    }
  });

  /** Every active variable of the template that still holds a placeholder of the operator's to replace. */
  const placeholders = Object.entries(productionVars)
    .filter(([, value]) => value.includes('CHANGE_ME'))
    .map(([name]) => name);

  it('marks every secret as a placeholder that production refuses until it is replaced (decision 055)', () => {
    for (const name of [
      'DATABASE_URL',
      'REDIS_QUEUE_URL',
      'REDIS_CACHE_URL',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'ENCRYPTION_KEYS',
      'CSRF_SECRET',
      'TOKEN_PEPPER',
      'LOOKUP_HASH_KEY',
      'METRICS_TOKEN',
      'MAIL_SMTP_URL',
      'TURNSTILE_SECRET_KEY',
      'FX_API_KEY',
    ]) {
      expect(productionVars[name], name).toContain('CHANGE_ME');
      expect(placeholders).toContain(name);
    }
    // Production refuses each of them, whatever rule says it first.
    const refused = issuesOf(productionVars).map((issue) => issue.variable);
    expect(placeholders.filter((name) => !refused.includes(name))).toEqual([]);
  });

  /** A valid value for each placeholder: a sibling feature that adds a placeholder to the template adds its row here. */
  const FILLED: Record<string, () => string> = {
    ENCRYPTION_KEYS: () => `k1:${randomBytes(32).toString('base64')}`,
    CSRF_SECRET: () => randomBytes(32).toString('hex'),
    TOKEN_PEPPER: () => randomBytes(32).toString('hex'),
    LOOKUP_HASH_KEY: () => randomBytes(32).toString('hex'),
    METRICS_TOKEN: () => randomBytes(32).toString('hex'),
    MAIL_SMTP_URL: () => 'smtps://user:pass@smtp.example.com:465',
    TURNSTILE_SECRET_KEY: () => 'turnstile-secret-for-the-test',
    // The exchange-rate key is a placeholder of the template (decision 049): production refuses openexchangerates without it.
    FX_API_KEY: () => 'fx-provider-key-for-the-test',
    S3_ACCESS_KEY_ID: () => 'minio-app-user',
    S3_SECRET_ACCESS_KEY: () => randomBytes(16).toString('hex'),
    DATABASE_URL: () => `postgres://gsm_app:${randomBytes(16).toString('hex')}@postgres:5432/gsm`,
    REDIS_QUEUE_URL: () => `redis://:${randomBytes(16).toString('hex')}@redis-queue:6379/0`,
    REDIS_CACHE_URL: () => `redis://:${randomBytes(16).toString('hex')}@redis-cache:6379/0`,
  };

  it('becomes a valid production configuration once the placeholders are replaced', () => {
    // A placeholder with no row in FILLED is a new one: fill it in the table above.
    expect(placeholders.filter((name) => FILLED[name] === undefined)).toEqual([]);
    const filled: Record<string, string> = { ...productionVars };
    for (const name of placeholders) filled[name] = (FILLED[name] as () => string)();
    const config = parseEnv(filled);
    expect(config.isProduction).toBe(true);
    expect(config.http.consoleOrigins).toEqual(['https://admin.example.com']);
    expect(config.http.shopOrigins).toEqual(['https://shop.example.com']);
    expect(config.warnings).toEqual([]);
    // Decision 055: the application's own role, a password on both Redis instances, and links signed for the files host.
    expect(new URL(config.database.url).username).toBe('gsm_app');
    expect(new URL(config.redis.queueUrl).hostname).toBe('redis-queue');
    expect(new URL(config.redis.queueUrl).password).toHaveLength(32);
    expect(new URL(config.redis.cacheUrl).hostname).toBe('redis-cache');
    expect(new URL(config.redis.cacheUrl).password).toHaveLength(32);
    expect(config.s3.publicEndpoint).toBe(`https://${deploy.FILES_HOST}`);
    expect(config.mail.requireTls).toBe(true);
  });

  it('names every compose-level variable the compose file reads in deploy/.env.example, active or as an optional line', () => {
    const named = new Set([
      ...Object.keys(deploy),
      ...[...read('deploy/.env.example').matchAll(/^# ([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] as string),
    ]);
    const used = new Set(
      [...read('deploy/compose.prod.yaml').matchAll(/\$\{([A-Z][A-Z0-9_]*)[:}?-]/g)].map((match) => match[1] as string),
    );
    expect(used.size).toBeGreaterThan(20);
    expect([...used].filter((name) => !named.has(name))).toEqual([]);
  });

  it('never carries the owner role: the compose file gives DATABASE_OWNER_URL to the migrate service only', () => {
    expect(production).not.toMatch(/^#?\s*DATABASE_OWNER_URL=/m);
    expect(productionVars.DATABASE_OWNER_URL).toBeUndefined();
    expect(commentedVariables(production)).not.toContain('DATABASE_OWNER_URL');
  });

  it('trusts exactly Caddy and the site, the two fixed addresses of the compose file, and the hosts agree with deploy/.env.example', () => {
    const compose = Bun.YAML.parse(read('deploy/compose.prod.yaml')) as {
      services: Record<string, { networks?: Record<string, { ipv4_address?: string }> }>;
    };
    const addresses = [
      compose.services.caddy?.networks?.edge?.ipv4_address as string,
      compose.services.site?.networks?.edge?.ipv4_address as string,
    ];
    expect(addresses.every((address) => /^172\.30\.1\.\d+$/.test(address))).toBe(true);
    expect(productionVars.TRUST_PROXY).toBe(addresses.join(','));
    expect(parseTrustProxy(productionVars.TRUST_PROXY)).toEqual({ ok: true, value: addresses });
    // Decision 045: the origins come from the base URLs; the old single list is refused in production.
    expect(productionVars.CORS_ORIGINS).toBeUndefined();
    expect(productionVars.CONSOLE_BASE_URL).toBe(`https://${deploy.ADMIN_HOST}`);
    expect(productionVars.STORE_BASE_URL).toBe(`https://${deploy.SHOP_HOST}`);
    expect(productionVars.PORTAL_BASE_URL).toBe(`https://${deploy.SHOP_HOST}/account`);
    expect(productionVars.ERRORS_BASE_URL).toBe(`https://${deploy.API_HOST}/errors`);
    expect(productionVars.TURNSTILE_HOSTNAMES).toBe(deploy.SHOP_HOST);
  });
});

describe('deploy/.env.example', () => {
  it('lists every compose-level variable the stack and the backups need', () => {
    for (const name of [
      'SHOP_HOST',
      'ADMIN_HOST',
      'API_HOST',
      'ACME_EMAIL',
      'BACKEND_IMAGE',
      'CONSOLE_IMAGE',
      'SITE_IMAGE',
      'FILES_HOST',
      'POSTGRES_PASSWORD',
      'REDIS_QUEUE_PASSWORD',
      'REDIS_CACHE_PASSWORD',
      'MINIO_ROOT_USER',
      'MINIO_ROOT_PASSWORD',
      'MINIO_APP_USER',
      'MINIO_APP_PASSWORD',
      'MINIO_BACKUP_USER',
      'MINIO_BACKUP_PASSWORD',
      'BACKUP_S3_ENDPOINT',
      'BACKUP_S3_BUCKET',
      'BACKUP_S3_ACCESS_KEY_ID',
      'BACKUP_S3_SECRET_ACCESS_KEY',
      'BACKUP_AGE_RECIPIENT',
      'BACKUP_RETENTION_DAYS',
      'BACKUP_MONTHLY_KEEP',
    ]) {
      expect(deploy[name]).toBeDefined();
    }
    expect(deploy.BACKUP_RETENTION_DAYS).toBe('30');
    expect(deploy.BACKUP_MONTHLY_KEEP).toBe('12');
  });
});
