// One reading of an account's status (decision 064): `canAct(status)` and `sessionStateOf(status)` of
// src/modules/identity/accounts/account-status.ts. A raw comparison of a status with 'suspended' (`status === 'suspended'`, SQL
// `status <> 'suspended'`, `eq(clients.status, 'suspended')`) decides for one status and forgets blocked and anonymized, so none may be
// written outside the helper and the schema. A staff member's status is not an account status and has its own word 'suspended': a line
// that says staff (or the line above it), a class or function with staff in its name, and a file with staff in its name are not read.
// The scan runs over the code of src; each pattern is proved on synthetic text that fails first. No database.
import { describe, expect, it } from 'bun:test';
import { type Hit, isSchemaFile, readSource, report, scanText, sourceFiles } from './lib/source-scan';

/** The comparisons of a status with the word suspended, in TypeScript and in SQL. */
const COMPARISONS: RegExp[] = [
  // status === 'suspended', row.status !== 'suspended', view.client.status == 'suspended'
  /\bstatus\s*[!=]==?\s*'suspended'/,
  // 'suspended' === client.status
  /'suspended'\s*[!=]==?\s*[\w.?!]*\bstatus\b/,
  // SQL: ${clients.status} <> 'suspended', status = 'suspended', status != 'suspended'
  /\bstatus\}?\s*(?:<>|!=|=)\s*'suspended'/,
  // SQL: status in ('active', 'suspended'), status not in ('suspended')
  /\bstatus\}?\s+(?:not\s+)?in\s*\([^)]*'suspended'/i,
  // Drizzle: eq(clients.status, 'suspended'), ne(x.status, 'suspended'), inArray(x.status, ['suspended', ...])
  /\b(?:eq|ne|inArray|notInArray)\(\s*[\w.]*\bstatus\s*,\s*\[?\s*'suspended'/,
  // [..., 'suspended'].includes(client.status)
  /'suspended'[^\n]{0,40}\]\.includes\(\s*[\w.?!]*\bstatus\b/,
];

/** A file where the word is not an account status: the helper itself, a schema file, and anything about staff. */
const exempt = (path: string): boolean =>
  path === 'src/modules/identity/accounts/account-status.ts' || isSchemaFile(path) || /staff/i.test(path);

/** The nearest declaration at the start of a line (class, function, const, ...) at or above a line: the scope a statement sits in. */
function declarationAbove(lines: string[], line: number): string {
  for (let i = line - 1; i >= 0; i--) {
    if (
      /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|function|const|let|interface|type|enum)\b/.test(
        lines[i] ?? '',
      )
    ) {
      return lines[i] ?? '';
    }
  }
  return '';
}

/**
 * The raw comparisons in a source text, one per line, without those that are about staff: the line or the line above says staff, or the
 * class or function the line sits in has staff in its name.
 * @param file the file name to report
 * @param source the text
 */
function rawComparisons(file: string, source: string): Hit[] {
  const lines = source.split('\n');
  const aboutStaff = (line: number): boolean =>
    /staff/i.test(lines[line - 1] ?? '') ||
    /staff/i.test(lines[line - 2] ?? '') ||
    /staff/i.test(declarationAbove(lines, line));
  const seen = new Set<number>();
  return COMPARISONS.flatMap((pattern) => scanText(file, source, pattern))
    .sort((a, b) => a.line - b.line)
    .filter((hit) => !aboutStaff(hit.line) && !seen.has(hit.line) && seen.add(hit.line));
}

describe('the patterns, on synthetic text', () => {
  const found = (text: string): number => rawComparisons('x.ts', text).length;

  it('finds a raw comparison with suspended in TypeScript', () => {
    expect(found("if (client.status === 'suspended') throw new AppError('ACCOUNT_SUSPENDED');")).toBe(1);
    expect(found("const eligible = client !== undefined && client.status !== 'suspended';")).toBe(1);
    expect(found("return view.client.status == 'suspended' ? 'suspended' : 'ok';")).toBe(1);
    expect(found("if ('suspended' === row.status) return;")).toBe(1);
    expect(found("const blocked = ['suspended', 'blocked'].includes(account.status);")).toBe(1);
  });

  it('finds a raw comparison with suspended in SQL and in Drizzle', () => {
    expect(found("sql`${clients.status} <> 'suspended'`")).toBe(1);
    expect(found("sql`select 1 from clients c where c.status = 'suspended'`")).toBe(1);
    expect(found("sql`select 1 from clients where status != 'suspended'`")).toBe(1);
    expect(found("sql`status not in ('suspended', 'blocked')`")).toBe(1);
    expect(found("where(eq(clients.status, 'suspended'))")).toBe(1);
    expect(found("where(inArray(clients.status, ['suspended', 'blocked']))")).toBe(1);
  });

  it('finds a comparison that wraps over two lines', () => {
    expect(found("if (\n  client.status ===\n    'suspended'\n) {")).toBe(1);
  });

  it('leaves the helper, the state it returns, an assignment, a comment and a staff status alone', () => {
    expect(found("if (!canAct(client.status)) throw new AppError('ACCOUNT_SUSPENDED');")).toBe(0);
    // the state sessionStateOf returns is not a status
    expect(found("if (view.subject.state === 'suspended') return;")).toBe(0);
    expect(found("return status === 'anonymized' ? 'gone' : 'suspended';")).toBe(0);
    // a write is not a comparison
    expect(found("await update({ status: 'suspended' });")).toBe(0);
    expect(found("after: { status: 'suspended', reason }")).toBe(0);
    expect(found("// the old test was client.status === 'suspended'")).toBe(0);
    // a staff member's status has its own suspended
    expect(found("if (staff.status === 'suspended') return;")).toBe(0);
    expect(found("sql`${staffUsers.status} <> 'suspended'`")).toBe(0);
    expect(found("// the staff row\nconst gone = row.status === 'suspended';")).toBe(0);
  });

  it('reads the line below a staff line, not two lines below', () => {
    expect(found("const staff = 1;\n\nconst gone = row.status === 'suspended';")).toBe(1);
  });

  it('leaves a class or function about staff alone, and finds the same comparison in the one about accounts', () => {
    const source = [
      '/** Staff: suspended stops everything. */',
      'class StaffSubjectResolver {',
      '  async resolve(row: Row) {',
      "    return { state: row.status === 'suspended' ? 'suspended' : 'ok' };",
      '  }',
      '}',
      '',
      'class ClientSubjectResolver {',
      '  async resolve(row: Row) {',
      "    return { state: row.status === 'suspended' ? 'suspended' : 'ok' };",
      '  }',
      '}',
    ].join('\n');
    expect(rawComparisons('x.ts', source).map((hit) => hit.line)).toEqual([10]);
  });

  it('counts a line once when two patterns find it', () => {
    expect(found("sql`select 1 from clients where status != 'suspended'`")).toBe(1);
  });
});

describe('the code of src', () => {
  const files = sourceFiles('src').filter((file) => !exempt(file));

  it('is read in full', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('compares no status with suspended outside account-status.ts, the schema files and the staff code', () => {
    const hits: Hit[] = files.flatMap((file) => rawComparisons(file, readSource(file)));
    expect(report(hits)).toEqual([]);
  });
});
