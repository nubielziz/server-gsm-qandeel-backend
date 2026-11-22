// Keeps the production env templates (feature 24D, decision 036) complete, consistent and free of development secrets:
// `.env.production.example` (the application's variables) and `deploy/.env.example` (the compose-level values).
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DEV_DEFAULTS, ENV_VARIABLES, parseEnv, parseTrustProxy } from '@src/config';

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

  it('marks every secret as a placeholder that production refuses until it is replaced', () => {
    for (const name of ['ENCRYPTION_KEYS', 'CSRF_SECRET', 'TOKEN_PEPPER', 'METRICS_TOKEN', 'TURNSTILE_SECRET_KEY']) {
      expect(productionVars[name]).toMatch(/^CHANGE_ME/);
    }
    expect(() => parseEnv(productionVars)).toThrow(/ENCRYPTION_KEYS|CSRF_SECRET|TOKEN_PEPPER/);
  });

  it('becomes a valid production configuration once the placeholders are replaced', () => {
    const filled: Record<string, string> = { ...productionVars };
    filled.ENCRYPTION_KEYS = `k1:${randomBytes(32).toString('base64')}`;
    filled.CSRF_SECRET = randomBytes(32).toString('hex');
    filled.TOKEN_PEPPER = randomBytes(32).toString('hex');
    filled.METRICS_TOKEN = randomBytes(32).toString('hex');
    filled.MAIL_SMTP_URL = 'smtps://user:pass@smtp.example.com:465';
    filled.TURNSTILE_SECRET_KEY = 'turnstile-secret-for-the-test';
    filled.S3_ACCESS_KEY_ID = 'minio-user';
    filled.S3_SECRET_ACCESS_KEY = 'minio-password';
    filled.DATABASE_URL = 'postgres://gsm:secretpassword@postgres:5432/gsm';
    const config = parseEnv(filled);
    expect(config.isProduction).toBe(true);
    expect(config.http.consoleOrigins).toEqual(['https://admin.example.com']);
    expect(config.http.shopOrigins).toEqual(['https://shop.example.com']);
    expect(config.warnings).toEqual([]);
    expect(config.redis.queueUrl).toBe('redis://redis-queue:6379/0');
    expect(config.redis.cacheUrl).toBe('redis://redis-cache:6379/0');
  });

  it('trusts exactly the compose subnet, and the hosts agree with deploy/.env.example', () => {
    const compose = Bun.YAML.parse(read('deploy/compose.prod.yaml')) as {
      networks: { gsm: { ipam: { config: { subnet: string }[] } } };
    };
    const subnet = compose.networks.gsm.ipam.config[0]?.subnet;
    expect(productionVars.TRUST_PROXY).toBe(subnet);
    expect(parseTrustProxy(productionVars.TRUST_PROXY)).toEqual({ ok: true, value: [subnet as string] });
    // Decision 045: the origins come from the base URLs; the old single list is refused in production.
    expect(productionVars.CORS_ORIGINS).toBeUndefined();
    expect(productionVars.CONSOLE_BASE_URL).toBe(`https://${deploy.ADMIN_HOST}`);
    expect(productionVars.STORE_BASE_URL).toBe(`https://${deploy.SHOP_HOST}`);
    expect(productionVars.PORTAL_BASE_URL).toBe(`https://${deploy.SHOP_HOST}/merchant`);
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
      'POSTGRES_PASSWORD',
      'MINIO_ROOT_USER',
      'MINIO_ROOT_PASSWORD',
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
