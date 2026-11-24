// Unit tests of the legacy resolver: the type words, the two SQL fragments and the lookups, with a fake database that records the
// statements it receives (the real map is read by test/integration/identity/account-directory.test.ts).
import { describe, expect, it } from 'bun:test';
import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DbExecutor } from '@src/infra/db';
import {
  type LegacyLookupType,
  LegacyAccounts,
  accountHistorySql,
  legacyAccountIdSql,
  legacySpaceOf,
} from '@src/modules/identity/accounts/legacy-accounts';

const dialect = new PgDialect();

/** The text of a statement on one line, and its parameters. */
function render(query: SQL): { text: string; params: unknown[] } {
  const built = dialect.sqlToQuery(query);
  return { text: built.sql.replace(/\s+/g, ' ').trim(), params: built.params };
}

/** A database that answers every statement with the given rows and keeps what it was asked. */
function fakeDb(rows: Record<string, unknown>[] = []): { db: DbExecutor; asked: SQL[] } {
  const asked: SQL[] = [];
  const db = {
    execute: (query: SQL) => {
      asked.push(query);
      return Promise.resolve({ rows });
    },
  } as unknown as DbExecutor;
  return { db, asked };
}

describe('legacySpaceOf', () => {
  it('names the number space of each account word', () => {
    expect(legacySpaceOf('account')).toBe('self');
    expect(legacySpaceOf('client')).toBe('client');
    expect(legacySpaceOf('merchant')).toBe('client');
    expect(legacySpaceOf('customer')).toBe('customer');
  });

  it('knows nothing of any other word', () => {
    for (const word of ['staff', 'system', 'order', 'supplier', '', 'Account', 'customers']) {
      expect(legacySpaceOf(word)).toBeUndefined();
    }
  });
});

describe('legacyAccountIdSql', () => {
  const { text, params } = render(legacyAccountIdSql(sql`a.entity_type`, sql`a.entity_id`));

  it('takes an account pair as the id itself', () => {
    expect(text).toContain("when a.entity_type = 'account' then a.entity_id");
  });

  it('looks merchant words up in the client numbers and customer words in the customer numbers', () => {
    expect(text).toContain(
      "when a.entity_type in ('client', 'merchant') then (select m.account_id from account_legacy_ids m where m.legacy_type = 'client' and m.legacy_id = a.entity_id)",
    );
    expect(text).toContain(
      "when a.entity_type = 'customer' then (select m.account_id from account_legacy_ids m where m.legacy_type = 'customer' and m.legacy_id = a.entity_id)",
    );
  });

  it('gives null for every other word and binds nothing', () => {
    expect(text).toContain('else null end');
    expect(params).toEqual([]);
  });
});

describe('accountHistorySql', () => {
  const { text, params } = render(accountHistorySql(sql`a.entity_type`, sql`a.entity_id`, 7));

  it('matches the account pair and the old numbers the map points at the account', () => {
    expect(text).toContain("a.entity_type = 'account' and a.entity_id = $1");
    expect(text).toContain(
      "a.entity_type in ('client', 'merchant') and a.entity_id in (select m.legacy_id from account_legacy_ids m where m.legacy_type = 'client' and m.account_id = $2)",
    );
    expect(text).toContain(
      "a.entity_type = 'customer' and a.entity_id in (select m.legacy_id from account_legacy_ids m where m.legacy_type = 'customer' and m.account_id = $3)",
    );
  });

  it('binds the account id as a parameter, never as text', () => {
    expect(params).toEqual([7, 7, 7]);
  });

  it('is the same through the class', () => {
    const legacy = new LegacyAccounts();
    expect(render(legacy.accountHistorySql(sql`a.entity_type`, sql`a.entity_id`, 7))).toEqual({ text, params });
    expect(render(legacy.legacyAccountIdSql(sql`a.entity_type`, sql`a.entity_id`)).text).toBe(
      render(legacyAccountIdSql(sql`a.entity_type`, sql`a.entity_id`)).text,
    );
  });
});

describe('LegacyAccounts.resolve', () => {
  const legacy = new LegacyAccounts();

  it('takes an account pair as the id itself, without reading the map', async () => {
    const { db, asked } = fakeDb();
    expect(await legacy.resolve(db, 'account', 12)).toBe(12);
    expect(asked).toHaveLength(0);
  });

  it('reads merchant words from the client numbers and a customer word from the customer numbers', async () => {
    const { db, asked } = fakeDb([{ account_id: '31' }]);
    expect(await legacy.resolve(db, 'client', 7)).toBe(31);
    expect(await legacy.resolve(db, 'merchant', 7)).toBe(31);
    expect(await legacy.resolve(db, 'customer', 7)).toBe(31);
    expect(asked.map((query) => render(query).params)).toEqual([
      ['client', 7],
      ['client', 7],
      ['customer', 7],
    ]);
  });

  it('answers undefined for a pair the map does not know, and never falls back to the same number as an account', async () => {
    const { db } = fakeDb([]);
    expect(await legacy.resolve(db, 'customer', 7)).toBeUndefined();
    expect(await legacy.resolve(db, 'client', 7)).toBeUndefined();
  });

  it('answers undefined for a word that is not an account word, without reading the map', async () => {
    const { db, asked } = fakeDb([{ account_id: '31' }]);
    for (const word of ['staff', 'system', 'order', '']) {
      expect(await legacy.resolve(db, word as LegacyLookupType, 7)).toBeUndefined();
    }
    expect(asked).toHaveLength(0);
  });

  it('answers undefined for an id that is not a positive whole number, without reading the map', async () => {
    const { db, asked } = fakeDb([{ account_id: '31' }]);
    for (const id of [0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(await legacy.resolve(db, 'account', id)).toBeUndefined();
      expect(await legacy.resolve(db, 'customer', id)).toBeUndefined();
    }
    expect(asked).toHaveLength(0);
  });
});

describe('LegacyAccounts.legacyIdsOf', () => {
  it('turns the rows of the map into pairs, in the order the map gave them', async () => {
    const { db, asked } = fakeDb([
      { legacy_type: 'client', legacy_id: '7' },
      { legacy_type: 'customer', legacy_id: '15' },
    ]);
    expect(await new LegacyAccounts().legacyIdsOf(db, 7)).toEqual([
      { type: 'client', id: 7 },
      { type: 'customer', id: 15 },
    ]);
    expect(asked.map((query) => render(query).params)).toEqual([[7]]);
  });

  it('gives an empty list for an account made after the merge', async () => {
    const { db } = fakeDb([]);
    expect(await new LegacyAccounts().legacyIdsOf(db, 500)).toEqual([]);
  });
});
