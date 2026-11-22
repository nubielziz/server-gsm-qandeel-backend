// The refusals of `bun run db:seed` (decision 055), proven without a process or a database: a production configuration, a database that is
// not on this machine, and the local test database.
import { describe, expect, it } from 'bun:test';
import { parseEnv } from '@src/config';
import { PRODUCTION_ENV } from '../support/app';
import { seedRefusal } from '../../scripts/seed/seed-guard';

describe('seedRefusal', () => {
  it('refuses a production configuration, even when its database is on this machine', () => {
    const config = parseEnv({ ...PRODUCTION_ENV, DATABASE_URL: 'postgres://app:pw@localhost:5432/gsm' });
    expect(seedRefusal(config)).toBe('db:seed is for development only and refuses a production configuration.');
  });

  it('refuses a database that is not on this machine, in development', () => {
    for (const url of [
      'postgres://gsm:gsm@db.example.com:5432/gsm',
      'postgres://gsm:gsm@10.0.0.5:5432/gsm',
      // A host named outside the authority counts.
      'postgres://gsm:gsm@localhost:5432/gsm?host=db.example.com',
    ]) {
      const config = parseEnv({ NODE_ENV: 'development', DATABASE_URL: url });
      expect(seedRefusal(config), url).toBe(
        'db:seed only works on a database on this machine (localhost, 127.x.x.x or ::1); nothing was changed.',
      );
    }
  });

  it('judges the host of PGHOST for a database URL that names none, because the driver connects there', () => {
    const withoutHost = 'postgres:///gsm?user=gsm&password=gsm';
    const refusal =
      'db:seed only works on a database on this machine (localhost, 127.x.x.x or ::1); nothing was changed.';
    expect(seedRefusal(parseEnv({ NODE_ENV: 'development', DATABASE_URL: withoutHost }))).toBeUndefined();
    expect(
      seedRefusal(parseEnv({ NODE_ENV: 'development', DATABASE_URL: withoutHost, PGHOST: 'localhost' })),
    ).toBeUndefined();
    expect(
      seedRefusal(parseEnv({ NODE_ENV: 'development', DATABASE_URL: withoutHost, PGHOST: 'db.example.com' })),
    ).toBe(refusal);
    // Under NODE_ENV=test the test database's URL is the one judged, with the same fallback.
    expect(
      seedRefusal(
        parseEnv({ NODE_ENV: 'test', DATABASE_URL_TEST: 'postgres:///gsm_test?user=gsm', PGHOST: 'db.example.com' }),
      ),
    ).toBe(refusal);
    // A URL that names its host is not changed by PGHOST.
    expect(
      seedRefusal(
        parseEnv({
          NODE_ENV: 'development',
          DATABASE_URL: 'postgres://gsm:gsm@localhost:5432/gsm',
          PGHOST: 'db.example.com',
        }),
      ),
    ).toBeUndefined();
  });

  it('judges the test database under NODE_ENV=test, not the development one', () => {
    const local = parseEnv({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://gsm:gsm@db.example.com:5432/gsm',
      DATABASE_URL_TEST: 'postgres://gsm:gsm@localhost:5434/gsm_45b_test',
    });
    expect(seedRefusal(local)).toBeUndefined();
    const remote = parseEnv({ NODE_ENV: 'test', DATABASE_URL_TEST: 'postgres://gsm:gsm@db.example.com:5432/gsm_test' });
    expect(seedRefusal(remote)).toContain('only works on a database on this machine');
  });

  it('lets the local development and test databases through', () => {
    expect(seedRefusal(parseEnv({ NODE_ENV: 'development' }))).toBeUndefined();
    expect(
      seedRefusal(parseEnv({ NODE_ENV: 'development', DATABASE_URL: 'postgres://gsm:gsm@127.0.0.1:5432/x' })),
    ).toBeUndefined();
    expect(seedRefusal(parseEnv({ NODE_ENV: 'test' }))).toBeUndefined();
  });
});
