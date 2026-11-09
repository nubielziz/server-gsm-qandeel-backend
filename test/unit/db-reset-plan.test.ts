// Unit tests of the guards and arguments of `bun run db:reset` (P4b): every refusal, proven without a database. The guards are what
// stand between this command and a production, shared or test database.
import { describe, expect, it } from 'bun:test';
import { type AppConfig, parseEnv } from '../../src/config';
import {
  ResetRefusedError,
  firstRunOfResetArgs,
  isLocalHost,
  parseResetArgs,
  planReset,
  refuseProductionEnv,
} from '../../scripts/lib/db-reset-plan';

/** A development configuration with the given overrides. */
function development(env: Record<string, string> = {}): AppConfig {
  return parseEnv({ NODE_ENV: 'development', ...env });
}

/** A complete production environment (the required secrets), as the deploy would give it. */
const PRODUCTION: Record<string, string> = {
  NODE_ENV: 'production',
  ERRORS_BASE_URL: 'https://errors.gsm.example',
  PORTAL_BASE_URL: 'https://portal.gsm.example',
  STORE_BASE_URL: 'https://shop.gsm.example',
  DATABASE_URL: 'postgres://app:pw@localhost:5432/gsm',
  REDIS_QUEUE_URL: 'redis://localhost:6379/0',
  REDIS_CACHE_URL: 'redis://localhost:6380/0',
  S3_BUCKET: 'gsm-prod-files',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'AKIA-ID',
  S3_SECRET_ACCESS_KEY: 'secret-access-key',
  CSRF_SECRET: 'c'.repeat(40),
  TOKEN_PEPPER: 'p'.repeat(40),
  ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
  ENCRYPTION_ACTIVE_KID: 'k1',
  METRICS_TOKEN: 'm'.repeat(32),
  MAIL_SMTP_URL: 'smtps://mailer:pw@smtp.gsm.example:465',
  MAIL_FROM: 'GSM <noreply@gsm.example>',
  TURNSTILE_SECRET_KEY: 'turnstile-secret-for-tests',
};

const refusal = (config: AppConfig) => {
  try {
    planReset(config);
  } catch (error) {
    expect(error).toBeInstanceOf(ResetRefusedError);
    return (error as Error).message;
  }
  throw new Error('Expected the reset to be refused.');
};

describe('planReset: what a development configuration may reset', () => {
  it('names the database, the maintenance database, both Redis databases and the bucket of the local defaults', () => {
    const target = planReset(development());
    expect(target.databaseName).toBe('gsm');
    expect(target.databaseUrl).toBe('postgres://gsm:gsm@localhost:5432/gsm');
    expect(target.adminUrl).toBe('postgres://gsm:gsm@localhost:5432/postgres');
    expect(target.redis).toEqual([
      { role: 'queue', url: 'redis://localhost:6379/0' },
      { role: 'cache', url: 'redis://localhost:6380/0' },
    ]);
    expect(target.bucket).toMatchObject({ name: 'gsm-files', endpoint: 'http://localhost:9000' });
  });

  it('accepts the loopback spellings: 127.x.x.x and [::1]', () => {
    const target = planReset(
      development({
        DATABASE_URL: 'postgres://gsm:gsm@127.0.0.2:5432/gsm_dev',
        REDIS_QUEUE_URL: 'redis://[::1]:6379/3',
        S3_ENDPOINT: 'http://127.0.0.1:9000',
      }),
    );
    expect(target.databaseName).toBe('gsm_dev');
  });

  it('drops the query string of the maintenance URL', () => {
    const target = planReset(development({ DATABASE_URL: 'postgres://gsm:gsm@localhost:5432/gsm?sslmode=disable' }));
    expect(target.adminUrl).toBe('postgres://gsm:gsm@localhost:5432/postgres');
  });
});

describe('planReset: what it refuses', () => {
  it('a production configuration, even when every server is local', () => {
    expect(refusal(parseEnv(PRODUCTION))).toContain('refuses a production configuration');
  });

  it('NODE_ENV=test, which would point at the test databases', () => {
    expect(refusal(parseEnv({ NODE_ENV: 'test' }))).toContain('refuses NODE_ENV=test');
  });

  it('a database whose name ends in _test, in any case', () => {
    expect(refusal(development({ DATABASE_URL: 'postgres://gsm:gsm@localhost:5432/gsm_test' }))).toContain(
      'test databases',
    );
    expect(refusal(development({ DATABASE_URL: 'postgres://gsm:gsm@localhost:5432/gsm_p4b_TEST' }))).toContain(
      'test databases',
    );
  });

  it('the server databases and names that are not plain identifiers', () => {
    for (const name of ['postgres', 'template0', 'template1', 'my-db', 'a%22b']) {
      expect(refusal(development({ DATABASE_URL: `postgres://gsm:gsm@localhost:5432/${name}` }))).toContain(
        'will not recreate',
      );
    }
  });

  it('a Postgres host that is not this machine, however it is spelled', () => {
    for (const url of [
      'postgres://gsm:gsm@db.example.com:5432/gsm',
      'postgres://gsm:gsm@10.0.0.5:5432/gsm',
      'postgres://gsm:gsm@localhost.evil.com:5432/gsm',
      'postgres://gsm:gsm@127.0.0.1.evil.com:5432/gsm',
      'postgres://gsm:gsm@0.0.0.0:5432/gsm',
      // node-postgres lets the query string override the host of the URL.
      'postgres://gsm:gsm@localhost:5432/gsm?host=db.example.com',
      'postgres://gsm:gsm@localhost:5432/gsm?hostaddr=10.0.0.5',
    ]) {
      expect(refusal(development({ DATABASE_URL: url }))).toContain('only works on this machine');
    }
  });

  it('a queue or cache Redis that is not this machine', () => {
    expect(refusal(development({ REDIS_QUEUE_URL: 'redis://queue.internal:6379/0' }))).toContain('queue Redis');
    expect(refusal(development({ REDIS_CACHE_URL: 'redis://cache.internal:6379/0' }))).toContain('cache Redis');
  });

  it('an S3 endpoint that is not this machine, or left to the AWS default', () => {
    expect(refusal(development({ S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com' }))).toContain('S3 endpoint');
    // Outside production the endpoint defaults to MinIO; only an explicit production-style config has none, so build one
    // by clearing the default through a config whose endpoint is unset.
    const config = development();
    const noEndpoint = { ...config, s3: { ...config.s3, endpoint: undefined } } as AppConfig;
    expect(refusal(noEndpoint)).toContain('S3_ENDPOINT is not set');
  });
});

describe('refuseProductionEnv', () => {
  it('refuses the raw production variable before the configuration is read', () => {
    expect(() => refuseProductionEnv('production')).toThrow(/refuses NODE_ENV=production/);
  });

  it('lets development, test and an unset variable pass (the configuration guards judge those)', () => {
    for (const value of ['development', 'test', undefined]) expect(() => refuseProductionEnv(value)).not.toThrow();
  });
});

describe('isLocalHost', () => {
  it('is true for this machine only', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '[::1]', '::1']) {
      expect(isLocalHost(host)).toBe(true);
    }
    for (const host of ['', '0.0.0.0', '128.0.0.1', 'example.com', '192.168.1.5', '[::2]', 'postgres']) {
      expect(isLocalHost(host)).toBe(false);
    }
  });
});

describe('parseResetArgs', () => {
  it('reads the three outcomes: nothing, --seed, and --setup with or without its owner', () => {
    expect(parseResetArgs([])).toEqual({ seed: false, setup: false, passwordStdin: false, help: false });
    expect(parseResetArgs(['--seed'])).toEqual({ seed: true, setup: false, passwordStdin: false, help: false });
    expect(parseResetArgs(['--setup'])).toEqual({ seed: false, setup: true, passwordStdin: false, help: false });
    expect(parseResetArgs(['--setup', '--email', 'a@b.co', '--name', 'Layla Haddad'])).toEqual({
      seed: false,
      setup: true,
      passwordStdin: false,
      help: false,
      email: 'a@b.co',
      name: 'Layla Haddad',
    });
    expect(
      parseResetArgs(['--setup', '--email', 'a@b.co', '--name', 'Layla Haddad', '--password-stdin']).passwordStdin,
    ).toBe(true);
  });

  it('refuses --seed with --setup, an owner or --password-stdin without --setup, and half an owner', () => {
    expect(() => parseResetArgs(['--seed', '--setup'])).toThrow(/not both/);
    expect(() => parseResetArgs(['--seed', '--setup', '--email', 'a@b.co', '--name', 'Layla Haddad'])).toThrow(
      /not both/,
    );
    expect(() => parseResetArgs(['--email', 'a@b.co', '--name', 'Layla Haddad'])).toThrow(/belong to --setup/);
    expect(() => parseResetArgs(['--seed', '--email', 'a@b.co'])).toThrow(/belong to --setup/);
    expect(() => parseResetArgs(['--seed', '--email', 'a@b.co', '--name', 'Layla Haddad', '--password-stdin'])).toThrow(
      /belong to --setup/,
    );
    expect(() => parseResetArgs(['--setup', '--email', 'a@b.co'])).toThrow(/Give both --email and --name/);
    expect(() => parseResetArgs(['--setup', '--name', 'Layla Haddad'])).toThrow(/Give both --email and --name/);
    // --password-stdin needs the account it belongs to.
    expect(() => parseResetArgs(['--setup', '--password-stdin'])).toThrow(/--password-stdin needs both/);
  });

  it('refuses unknown options with a ResetRefusedError', () => {
    expect(() => parseResetArgs(['--force'])).toThrow(ResetRefusedError);
  });

  it('does not repeat a password given as an unknown option', () => {
    expect(() => parseResetArgs(['--setup', '--password=Hunter2-secret-99'])).toThrow(ResetRefusedError);
    try {
      parseResetArgs(['--setup', '--password=Hunter2-secret-99']);
    } catch (error) {
      expect((error as Error).message).not.toContain('Hunter2');
      expect((error as Error).message).toContain('--password-stdin');
    }
  });

  it('refuses a repeated --seed or --setup, as setup refuses a repeated option', () => {
    expect(() => parseResetArgs(['--seed', '--seed'])).toThrow(/--seed was given twice/);
    expect(() => parseResetArgs(['--setup', '--setup'])).toThrow(/--setup was given twice/);
    expect(() => parseResetArgs(['--setup', '--email', 'a@b.co', '--name', 'Layla Haddad', '--setup'])).toThrow(
      ResetRefusedError,
    );
    expect(() => parseResetArgs(['--seed', '--seed'])).toThrow(ResetRefusedError);
  });

  it('answers --help whatever else is there', () => {
    expect(parseResetArgs(['--help']).help).toBe(true);
  });
});

describe('firstRunOfResetArgs', () => {
  const ask = parseResetArgs(['--setup']);
  const named = parseResetArgs(['--setup', '--email', 'A@B.co', '--name', 'Layla  Haddad']);

  it('has nothing to do without --setup', () => {
    expect(firstRunOfResetArgs(parseResetArgs([]), { terminal: true })).toBeUndefined();
    expect(firstRunOfResetArgs(parseResetArgs(['--seed']), { terminal: false })).toBeUndefined();
  });

  it('asks the questions when --setup has no owner and there is a terminal', () => {
    expect(firstRunOfResetArgs(ask, { terminal: true })).toEqual({ owner: undefined, interactive: true });
  });

  it('refuses --setup without an owner and without a terminal, before anything is dropped', () => {
    expect(() => firstRunOfResetArgs(ask, { terminal: false })).toThrow(ResetRefusedError);
    expect(() => firstRunOfResetArgs(ask, { terminal: false })).toThrow(
      /--setup needs a terminal to ask for the first admin, or pass --email and --name/,
    );
  });

  it('takes the owner from the flags, cleaned by the staff rules, with or without a terminal', () => {
    for (const terminal of [true, false]) {
      expect(firstRunOfResetArgs(named, { terminal })).toEqual({
        owner: { email: 'a@b.co', name: 'Layla Haddad' },
        interactive: false,
      });
    }
  });

  it('checks the owner before the drop: a bad email, a bad name, a weak password', () => {
    const bad = (argv: string[], password?: string) =>
      firstRunOfResetArgs(parseResetArgs(argv), { terminal: true, password });
    expect(() => bad(['--setup', '--email', 'Bad Email', '--name', 'Layla Haddad'])).toThrow(ResetRefusedError);
    expect(() => bad(['--setup', '--email', 'a@b.co', '--name', 'L'])).toThrow(/--name/);
    const stdin = ['--setup', '--email', 'a@b.co', '--name', 'Layla Haddad', '--password-stdin'];
    expect(() => bad(stdin, 'short')).toThrow(/Use at least 10 characters/);
    expect(bad(stdin, 'a-long-passphrase-4U')).toEqual({
      owner: { email: 'a@b.co', name: 'Layla Haddad', password: 'a-long-passphrase-4U' },
      interactive: false,
    });
  });

  it('never turns a missing stdin password into a generated one', () => {
    const stdin = parseResetArgs(['--setup', '--email', 'a@b.co', '--name', 'Layla Haddad', '--password-stdin']);
    expect(() => firstRunOfResetArgs(stdin, { terminal: true })).toThrow(/no password was read/);
  });
});
