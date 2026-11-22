// Unit tests of database selection (decision 014): tests can never reach the development database.
import { describe, expect, it } from 'bun:test';
import { parseEnv } from '@src/config';
import { databaseUrlFor, ownerUrlFor } from '@src/infra/db/url';

const URLS = { DATABASE_URL: 'postgres://u:p@host/dev', DATABASE_URL_TEST: 'postgres://u:p@host/dev_test' };

describe('databaseUrlFor', () => {
  it('uses DATABASE_URL in development and DATABASE_URL_TEST under NODE_ENV=test', () => {
    expect(databaseUrlFor(parseEnv({ ...URLS, NODE_ENV: 'development' }))).toBe('postgres://u:p@host/dev');
    expect(databaseUrlFor(parseEnv({ ...URLS, NODE_ENV: 'test' }))).toBe('postgres://u:p@host/dev_test');
  });

  it('defaults to the compose databases', () => {
    expect(databaseUrlFor(parseEnv({ NODE_ENV: 'development' }))).toBe('postgres://gsm:gsm@localhost:5432/gsm');
    expect(databaseUrlFor(parseEnv({ NODE_ENV: 'test' }))).toBe('postgres://gsm:gsm@localhost:5432/gsm_test');
  });
});

describe('ownerUrlFor (decision 055)', () => {
  const OWNER = 'postgres://gsm:owner@host/dev';

  it('uses DATABASE_OWNER_URL when it is set, and DATABASE_URL otherwise (the owner is then the only role)', () => {
    expect(ownerUrlFor(parseEnv({ ...URLS, DATABASE_OWNER_URL: OWNER, NODE_ENV: 'development' }))).toBe(OWNER);
    expect(ownerUrlFor(parseEnv({ ...URLS, NODE_ENV: 'development' }))).toBe('postgres://u:p@host/dev');
  });

  it('is the test database under NODE_ENV=test, whatever else is set', () => {
    expect(ownerUrlFor(parseEnv({ ...URLS, DATABASE_OWNER_URL: OWNER, NODE_ENV: 'test' }))).toBe(
      'postgres://u:p@host/dev_test',
    );
  });
});
