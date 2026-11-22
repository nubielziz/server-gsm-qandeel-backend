// Finds a migration file by its name suffix (the lead renumbers migrations at merge, so tests never name the number) and reads its statements.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DRIZZLE_DIR = join(import.meta.dir, '../../drizzle');

/**
 * The text of the migration whose file name ends with a suffix.
 *
 * @param suffix the part after the number, for example `_supplier_safety.sql`
 * @returns the file's text
 * @throws {Error} when no file, or more than one, ends with the suffix
 */
export function migrationSql(suffix: string): string {
  const names = readdirSync(DRIZZLE_DIR).filter((name) => name.endsWith(suffix));
  if (names.length !== 1) throw new Error(`Expected one migration ending with ${suffix}, found ${names.length}.`);
  return readFileSync(join(DRIZZLE_DIR, names[0]!), 'utf8');
}

/**
 * The statements of a migration without their comment lines, split on drizzle's statement breakpoint.
 *
 * @param suffix the part after the number
 * @returns the statements, trimmed
 */
export function migrationStatements(suffix: string): string[] {
  return migrationSql(suffix)
    .split('--> statement-breakpoint')
    .map((part) =>
      part
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement !== '');
}
