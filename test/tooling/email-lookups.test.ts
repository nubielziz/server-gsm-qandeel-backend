// One reader finds an account by its email (decision 064): AccountDirectory, in
// src/modules/identity/accounts/account-directory.repository.ts. A login row and a guest row may hold one email (two partial unique
// indexes), so a lookup written anywhere else could return the guest row where the sign-in, the forgot-password route or the sign-in
// lock needs the login row, whatever the order the rows were inserted in. This test reads the code of src for an equality comparison of
// `clients.email` outside that file: Drizzle `eq(lower(clients.email), ...)`, SQL `lower(clients.email) = ...` and the same through an
// alias of the table (`from clients c ... lower(c.email) = ...`). A search with `ilike` stays allowed. Proved on synthetic text that
// fails first. No database.
import { describe, expect, it } from 'bun:test';
import { type Hit, readSource, report, scanText, sourceFiles } from './lib/source-scan';

/** The one file that may compare the email of an account. */
const READER = 'src/modules/identity/accounts/account-directory.repository.ts';

/** Words that can follow a table name in SQL without being its alias. */
const NOT_AN_ALIAS = new Set(
  'on where join left right inner outer cross full natural using for limit order group having union returning set values select as and or'.split(
    ' ',
  ),
);

/** The aliases a text gives to the clients table: `from clients c`, `join clients as a`. */
function aliasesOfClients(code: string): string[] {
  const found = new Set<string>();
  for (const match of code.matchAll(
    /\b(?:from|join)\s+(?:public\.)?"?clients"?(?:\s+as)?\s+"?([a-z_][a-z0-9_]*)"?/gi,
  )) {
    const alias = match[1]!.toLowerCase();
    if (!NOT_AN_ALIAS.has(alias)) found.add(alias);
  }
  return [...found];
}

/** The patterns that read an email of the clients table for equality, given the aliases the text uses for the table. */
function patternsFor(aliases: string[]): RegExp[] {
  const table = ['clients', ...aliases].join('|');
  return [
    // Drizzle: eq(clients.email, x), eq(lower(clients.email), x), ne(...), inArray(...)
    /\b(?:eq|ne|inArray|notInArray)\(\s*(?:lower\(\s*)?clients\.email\b/,
    // Drizzle: eq(sql`lower(${clients.email})`, x)
    /\b(?:eq|ne)\(\s*sql`\s*lower\(\s*\$\{\s*clients\.email\s*\}\s*\)\s*`/,
    // sql`lower(${clients.email}) = ${x}`, sql`${clients.email} = ${x}`
    /\blower\(\s*\$\{\s*clients\.email\s*\}\s*\)\s*(?:=|<>|!=|\bin\b)/i,
    /\$\{\s*clients\.email\s*\}\s*(?:=|<>|!=)/,
    // raw SQL: lower(clients.email) = $1, lower(c.email) = lower(x.email), c.email = $1
    new RegExp(`\\blower\\(\\s*(?:${table})\\.email\\s*\\)\\s*(?:=|<>|!=|\\bin\\b)`, 'i'),
    new RegExp(`\\b(?:${table})\\.email\\s*(?:=|<>|!=)`, 'i'),
  ];
}

/** Every equality comparison of the email of an account in a source text. */
function emailLookups(file: string, source: string): Hit[] {
  const patterns = patternsFor(aliasesOfClients(source));
  const seen = new Set<string>();
  return patterns
    .flatMap((pattern) => scanText(file, source, pattern))
    .sort((a, b) => a.line - b.line)
    .filter((hit) => !seen.has(`${hit.line}`) && seen.add(`${hit.line}`));
}

describe('the patterns, on synthetic text', () => {
  const found = (text: string): number => emailLookups('x.ts', text).length;

  it('finds a Drizzle comparison of clients.email', () => {
    expect(found('.where(eq(lower(clients.email), email.trim().toLowerCase()))')).toBe(1);
    expect(found('.where(eq(clients.email, email))')).toBe(1);
    expect(found('.where(\n  eq(\n    lower(clients.email),\n    email,\n  ),\n)')).toBe(1);
    expect(found('.where(eq(sql`lower(${clients.email})`, email))')).toBe(1);
    expect(found('.where(inArray(clients.email, emails))')).toBe(1);
  });

  it('finds a SQL comparison of clients.email, with the table name or an alias of it', () => {
    expect(found('sql`lower(${clients.email}) = ${email.toLowerCase()}`')).toBe(1);
    expect(found('sql`select id from clients where lower(clients.email) = $1`')).toBe(1);
    expect(found('sql`select 1 from clients c where lower(c.email) = ${email}`')).toBe(1);
    expect(found('sql`select 1 from orders o join clients as a on a.id = o.account_id where a.email = $1`')).toBe(1);
    expect(found('sql`select 1 from public.clients "acct" where lower(acct.email) in ($1, $2)`')).toBe(1);
  });

  it('leaves a search, another table, comments and the other columns of clients alone', () => {
    // the q search of the admin list
    expect(found('sql`${clients.email} ilike ${pattern}`')).toBe(0);
    expect(found('ilike(clients.email, pattern)')).toBe(0);
    // an alias of another table that happens to be written c
    expect(found('sql`select 1 from checkout_sessions cs where lower(cs.email) = ${email}`')).toBe(0);
    expect(found('sql`select 1 from staff_users s where lower(s.email) = $1`')).toBe(0);
    expect(found('.where(eq(lower(staffUsers.email), email))')).toBe(0);
    // another column of clients, the email selected or ordered
    expect(found('.where(eq(clients.username, name)).orderBy(clients.email)')).toBe(0);
    expect(found('select({ email: clients.email }).from(clients)')).toBe(0);
    expect(found('// eq(lower(clients.email), email) was the old lookup\n/* lower(clients.email) = $1 */')).toBe(0);
  });

  it('does not take a SQL keyword for an alias of the table', () => {
    expect(aliasesOfClients('select 1 from clients where lower(email) = $1')).toEqual([]);
    expect(aliasesOfClients('from clients join orders on true')).toEqual([]);
    expect(aliasesOfClients('from clients c join clients as d on true')).toEqual(['c', 'd']);
  });
});

describe('the code of src', () => {
  const files = sourceFiles('src').filter((file) => file !== READER);

  it('is read in full', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('compares the email of an account for equality only in the account directory', () => {
    const hits: Hit[] = files.flatMap((file) => emailLookups(file, readSource(file)));
    expect(report(hits)).toEqual([]);
  });
});
