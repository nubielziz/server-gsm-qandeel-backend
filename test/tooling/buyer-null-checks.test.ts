// A buyer is never inferred from a NULL (decision 064): every order, invoice, payment, dispute and data request has an
// account_id, and the door is orders.source, so code that asks "is this a merchant's order?" with `clientId === null` or "is this a
// customer's?" with `customer_id is not null` reads columns that no longer say it. TypeScript does not flag a null comparison of a
// NOT NULL column, so this test reads the code of the modules that hold buyers (orders, health, money, risk, catalog, customers) for
// `clientId` and `customerId` against null, in TypeScript and in SQL. Proved on synthetic text that fails first. No database.
import { describe, expect, it } from 'bun:test';
import { type Hit, isSchemaFile, readSource, report, scanText, sourceFiles } from './lib/source-scan';

/** The modules whose code reads buyers. */
const MODULES = ['orders', 'health', 'money', 'risk', 'catalog', 'customers'];

/** A null comparison of a client or customer id, in TypeScript (both sides, strict or loose) and in SQL, and the Drizzle helpers. */
const NULL_CHECKS: RegExp[] = [
  // clientId === null, row.customerId !== null, order.clientId == null
  /\b(?:client|customer)Id\s*[!=]==?\s*null\b/,
  // null === clientId
  /\bnull\s*[!=]==?\s*[\w.?!]*\b(?:client|customer)Id\b/,
  // client_id is null, customer_id IS NOT NULL
  /\b(?:client|customer)_id\s+is\s+(?:not\s+)?null\b/i,
  // isNull(orders.clientId), isNotNull(payments.customerId)
  /\bis(?:Not)?Null\(\s*[\w.]*\b(?:client|customer)Id\s*\)/,
];

/** Every null check of a buyer id in a source text, one per place. */
const nullChecks = (file: string, source: string): Hit[] =>
  NULL_CHECKS.flatMap((pattern) => scanText(file, source, pattern));

describe('the patterns, on synthetic text', () => {
  const found = (text: string): number => nullChecks('x.ts', text).length;

  it('finds a null comparison of clientId or customerId in TypeScript', () => {
    expect(found('if (order.clientId === null) return "b2c";')).toBe(1);
    expect(found('const isMerchant = order.clientId !== null;')).toBe(1);
    expect(found('return payment.customerId == null ? undefined : payment.customerId;')).toBe(1);
    expect(found('const b2c = customerId != null;')).toBe(1);
    expect(found('if (null === row.clientId) return;')).toBe(1);
    expect(found('where(isNull(orders.clientId), isNotNull(payments.customerId))')).toBe(2);
  });

  it('finds a null comparison of client_id or customer_id in SQL, in any case', () => {
    expect(found('sql`select 1 from orders where client_id is null`')).toBe(1);
    expect(found('sql`... and o.client_id IS NOT NULL`')).toBe(1);
    expect(found('sql`where customer_id is null`')).toBe(1);
    expect(found('sql`where customer_id is not null and x`')).toBe(1);
  });

  it('leaves the new column, a comparison with a value, an optional filter and comments alone', () => {
    expect(found('if (order.accountId === null) return;')).toBe(0);
    expect(found('const same = order.clientId === merchant.id;')).toBe(0);
    // a filter that is not given is undefined, not a NULL of a column
    expect(found('if (query.clientId === undefined) return;')).toBe(0);
    expect(found('sql`where client_id = ${id} and account_id is null`')).toBe(0);
    expect(found('// the old test was order.clientId === null')).toBe(0);
    expect(found('const legacy = order.legacyClientId !== null;')).toBe(0);
  });
});

describe('the code of the modules that hold buyers', () => {
  const files = MODULES.flatMap((module) => sourceFiles(`src/modules/${module}`)).filter((file) => !isSchemaFile(file));

  it('is read in full', () => {
    expect(files.length).toBeGreaterThan(150);
    for (const module of MODULES)
      expect(
        files.some((file) => file.startsWith(`src/modules/${module}/`)),
        module,
      ).toBe(true);
  });

  it('infers no buyer from a null clientId, customerId, client_id or customer_id', () => {
    const hits: Hit[] = files.flatMap((file) => nullChecks(file, readSource(file)));
    expect(report(hits)).toEqual([]);
  });
});
