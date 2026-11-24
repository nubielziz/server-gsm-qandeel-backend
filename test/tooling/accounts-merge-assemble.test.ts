// The assembler of the expand migration of one account type (backend decision 064; scripts/accounts-merge/assemble.ts): the committed
// migration is exactly what assembling it again gives, its generated statements are the ones drizzle-kit generates from the schema (as a
// set, in a temporary copy of drizzle/, the method of scripts/db-check.ts, less what the later migrations hold), its phases come in order
// between their markers, and a generated statement the phase map does not name stops the script without writing anything.
import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  AssembleError,
  MARKERS,
  ROOT,
  assemble,
  assembleRelease,
  chunksOf,
  generatedStatementsOf,
  readRelease,
} from '../../scripts/accounts-merge/assemble';
import { ACCOUNTS_EXPAND_SUFFIX, journalEntries, migrationFileName, migrationSql } from '../support/migration-files';

// drizzle-kit generate reads the whole schema; on a busy machine it takes a while.
setDefaultTimeout(180_000);

const committed = migrationSql(ACCOUNTS_EXPAND_SUFFIX);
const { map, phaseFiles } = readRelease('expand');

/**
 * The statements of the migrations committed after the expand migration, without their comment lines: a schema change made later (the
 * field names of decision 065, for example) is generated from today's schema too, but it belongs to its own migration.
 */
function laterStatements(): Set<string> {
  const entries = journalEntries();
  const first = entries.findIndex((entry) => `${entry.tag}.sql` === migrationFileName(ACCOUNTS_EXPAND_SUFFIX));
  return new Set(
    entries.slice(first + 1).flatMap((entry) =>
      chunksOf(readFileSync(join(ROOT, 'drizzle', `${entry.tag}.sql`), 'utf8')).map((chunk) =>
        chunk
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('--'))
          .join('\n')
          .trim(),
      ),
    ),
  );
}

/** The statements drizzle-kit generates now for the expand migration, in a temporary copy of drizzle/ without it and the files after it. */
async function freshGeneration(): Promise<string[]> {
  const work = mkdtempSync(join(tmpdir(), 'gsm-assemble-'));
  try {
    const folder = join(work, 'drizzle');
    cpSync(join(ROOT, 'drizzle'), folder, { recursive: true });
    const entries = journalEntries();
    const first = entries.findIndex((entry) => `${entry.tag}.sql` === migrationFileName(ACCOUNTS_EXPAND_SUFFIX));
    expect(first).toBeGreaterThan(0);
    for (const entry of entries.slice(first)) {
      rmSync(join(folder, `${entry.tag}.sql`));
      rmSync(join(folder, 'meta', `${String(entry.idx).padStart(4, '0')}_snapshot.json`));
    }
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
    journal.entries = journal.entries.slice(0, first);
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));
    const config = {
      dialect: 'postgresql',
      schema: './src/infra/db/schema.ts',
      out: relative(ROOT, folder),
      casing: 'snake_case',
    };
    writeFileSync(join(work, 'drizzle.config.mjs'), `export default ${JSON.stringify(config)};\n`);
    const before = new Set(readdirSync(folder));
    const child = Bun.spawn(
      [
        process.execPath,
        join(ROOT, 'node_modules/drizzle-kit/bin.cjs'),
        'generate',
        '--name',
        'fresh_expand',
        '--config',
        join(work, 'drizzle.config.mjs'),
      ],
      { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
    );
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, `${output}${errors}`).toBe(0);
    const added = readdirSync(folder).filter((name) => !before.has(name) && name.endsWith('.sql'));
    expect(added).toHaveLength(1);
    return chunksOf(readFileSync(join(folder, added[0]!), 'utf8'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe('the committed expand migration', () => {
  it('is exactly what assembling it again gives', () => {
    expect(assemble(generatedStatementsOf(committed, map), map, phaseFiles)).toBe(committed);
  });

  it('holds, as a set, the statements drizzle-kit generates from the schema today', async () => {
    const later = laterStatements();
    const fresh = (await freshGeneration()).filter((statement) => !later.has(statement));
    expect([...generatedStatementsOf(committed, map)].sort()).toEqual([...fresh].sort());
  });

  it('holds every phase once, in order, between its markers, and the preflight block inside phase 0', () => {
    const lines = committed.split('\n');
    const position = (prefix: string) => {
      const found = lines.flatMap((line, index) => (line.startsWith(prefix) ? [index] : []));
      expect(found, prefix).toHaveLength(1);
      return found[0]!;
    };
    let last = -1;
    for (const entry of map.phases) {
      const begin = position(`${MARKERS.phaseBegin(entry.phase)} `);
      const end = position(MARKERS.phaseEnd(entry.phase));
      expect(begin).toBeGreaterThan(last);
      expect(end).toBeGreaterThan(begin);
      last = end;
    }
    const preflightBegin = position(MARKERS.preflightBegin);
    const preflightEnd = position(MARKERS.preflightEnd);
    expect(preflightBegin).toBeGreaterThan(position(`${MARKERS.phaseBegin(0)} `));
    expect(preflightEnd).toBeLessThan(position(MARKERS.phaseEnd(0)));
  });

  it('writes the four current checks NOT VALID, the five account columns nullable, and SET NOT NULL only after their backfill', () => {
    const notValid = chunksOf(committed).filter((chunk) => chunk.includes('NOT VALID;'));
    expect(notValid.map((chunk) => /ADD CONSTRAINT "([^"]+)"/.exec(chunk)?.[1]).sort()).toEqual([
      'audit_logs_actor_type_current_check',
      'ledger_transactions_created_by_type_current_check',
      'ledger_transactions_ref_type_current_check',
      'order_events_actor_type_current_check',
    ]);
    for (const table of ['orders', 'invoices', 'payments', 'disputes', 'data_requests']) {
      expect(committed).toContain(`ALTER TABLE "${table}" ADD COLUMN "account_id" bigint;`);
      const setNotNull = committed.indexOf(`ALTER TABLE "${table}" ALTER COLUMN "account_id" SET NOT NULL;`);
      expect(setNotNull).toBeGreaterThan(committed.indexOf(`${MARKERS.phaseBegin(5)} `));
      expect(setNotNull).toBeLessThan(committed.indexOf(MARKERS.phaseEnd(5)));
    }
  });
});

describe('the assembler', () => {
  it('stops on a generated statement the phase map does not name, and names it', () => {
    const generated = [...generatedStatementsOf(committed, map), 'ALTER TABLE "clients" ADD COLUMN "nickname" text;'];
    expect(() => assemble(generated, map, phaseFiles)).toThrow(AssembleError);
    expect(() => assemble(generated, map, phaseFiles)).toThrow('add-column clients.nickname');
  });

  it('writes nothing when it stops', () => {
    const root = mkdtempSync(join(tmpdir(), 'gsm-assemble-root-'));
    try {
      mkdirSync(join(root, 'drizzle'));
      cpSync(join(ROOT, 'scripts', 'accounts-merge', 'expand'), join(root, 'scripts', 'accounts-merge', 'expand'), {
        recursive: true,
      });
      const plain = `${generatedStatementsOf(committed, map).join('--> statement-breakpoint\n')}--> statement-breakpoint\nDROP TABLE "customers";`;
      const path = join(root, 'drizzle', '0099_accounts_expand.sql');
      writeFileSync(path, plain);
      expect(() => assembleRelease('expand', root)).toThrow('drop-table customers');
      expect(readFileSync(path, 'utf8')).toBe(plain);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('assembles a file drizzle-kit wrote into the committed one', () => {
    const plain = generatedStatementsOf(committed, map).join('--> statement-breakpoint\n');
    expect(assemble(generatedStatementsOf(plain, map), map, phaseFiles)).toBe(committed);
  });
});
