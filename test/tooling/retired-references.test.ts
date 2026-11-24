// No code reads or writes what the one account type retires (decision 064; the "retired references" scan). The
// customers tables and the customer_id columns stay in the database until the contract release, and in TypeScript they are renamed
// (retiredCustomers, retiredCustomerId, legacyClientId) so the compiler finds every reader. Raw SQL is the reader the compiler cannot
// see: this test reads the code of src for the old names. Files allowed to name them: the schema files, which declare them, and the
// legacy resolver of the identity module (src/modules/identity/accounts), which reads old numbers through the map. Each pattern is
// proved on synthetic text that fails first. No database, no Nest application.
import { describe, expect, it } from 'bun:test';
import { type Hit, isSchemaFile, readSource, report, scanText, sourceFiles } from './lib/source-scan';

/**
 * The release this repository is in. The expand release forbids the names of the retired SQL objects; the contract release
 * sets this to 'contract', which also forbids the TypeScript names `legacyClientId` and `retired*` (the objects are dropped then).
 */
const RELEASE: 'expand' | 'contract' = 'expand';

/** The names of the retired SQL objects: raw SQL that still touches the customers tables or the customer_id columns. */
const SQL_NAMES = /\bcustomer_id\b|\bcustomer_credentials\b|\bfrom\s+customers\b|\bjoin\s+customers\b/i;
/** The TypeScript names of the retired columns and tables, forbidden once the contract release has dropped them. */
const TS_NAMES = /\blegacyClientId\b|\bretired[A-Z]\w*\b/;

/** The patterns of a release. */
const patternsOf = (release: 'expand' | 'contract'): RegExp[] =>
  release === 'expand' ? [SQL_NAMES] : [SQL_NAMES, TS_NAMES];

/** Every place the code of a text names an object the release forbids, in the order of the file. */
const forbidden = (file: string, source: string, release: 'expand' | 'contract'): Hit[] =>
  patternsOf(release)
    .flatMap((pattern) => scanText(file, source, pattern))
    .sort((a, b) => a.line - b.line);

/** A file that may name the retired objects: a schema file, or the legacy resolver of the identity module. */
const mayNameThem = (path: string): boolean => isSchemaFile(path) || path.startsWith('src/modules/identity/accounts/');

describe('the pattern of the expand release, on synthetic text', () => {
  const found = (text: string): number => forbidden('x.ts', text, 'expand').length;

  it('finds each retired SQL name in code, in a string or a template literal', () => {
    expect(found('sql`select customer_id from orders where id = ${id}`')).toBe(1);
    expect(found('const q = "select * from customers c where c.id = $1";')).toBe(1);
    expect(found('const q = `select 1 from orders o\n join customers c on c.id = o.customer_id`;')).toBe(2);
    expect(found("const t = 'customer_credentials';")).toBe(1);
    expect(found('FROM   CUSTOMERS')).toBe(1);
  });

  it('leaves a comment, a word that only contains one, and the module of the same name alone', () => {
    expect(found('// the customer_id column, from customers, is retired')).toBe(0);
    expect(found('/* join customers on customer_credentials */')).toBe(0);
    expect(found("import { CustomersModule } from '../customers';")).toBe(0);
    expect(found('const retiredCustomerId = 1; const customerIds = [];')).toBe(0);
    expect(found("const t = 'customers_retired';")).toBe(0);
  });

  it('forbids the TypeScript names only in the contract release', () => {
    const text = 'const id = order.legacyClientId + row.retiredCustomerId; retiredCustomers;';
    expect(forbidden('x.ts', text, 'expand')).toEqual([]);
    expect(forbidden('x.ts', text, 'contract').map((hit) => hit.text)).toEqual([
      'legacyClientId',
      'retiredCustomerId',
      'retiredCustomers',
    ]);
  });
});

describe('the code of src', () => {
  const files = sourceFiles('src');

  it('is read in full: the schema files and the legacy resolver are the only files allowed to name the old objects', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.filter(isSchemaFile).length).toBeGreaterThan(10);
  });

  it(`names no retired SQL object outside the schema files and the legacy resolver (${RELEASE} release)`, () => {
    const hits: Hit[] = [];
    for (const file of files) {
      if (mayNameThem(file)) continue;
      hits.push(...forbidden(file, readSource(file), RELEASE));
    }
    expect(report(hits)).toEqual([]);
  });
});
