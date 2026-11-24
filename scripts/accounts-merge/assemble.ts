// `bun scripts/accounts-merge/assemble.ts <expand|contract>`: turns the migration drizzle-kit generated for a release of one account type
// (backend decision 064) into the migration that runs, in place. drizzle-kit writes the schema statements in its own order; the data must
// move between them (copy the accounts before the new checks, backfill a column before it becomes NOT NULL). This script sorts every
// generated statement into its phase by `scripts/accounts-merge/<release>/phase-map.json` (keyed by the kind of statement and the name of
// the table, column, constraint or index), inserts the hand-written statements of `phases/<nn>-<name>.sql` where the map says, marks each
// generated statement, and writes the phase and preflight markers. The snapshot drizzle-kit wrote stays as it is, so `db:check` passes.
//
// Running it again on its own output changes nothing: the generated statements are read back from their markers. A generated statement
// the map does not name stops the script and is printed, so a schema change after a rebase is never placed by guess. Nothing here goes
// into the image (the .dockerignore keeps scripts/accounts-merge out).
// Exit codes: 0 written; 1 any error (nothing is written).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The separator drizzle's migrator splits a migration file on; every chunk between two of them is sent as one query. */
export const BREAKPOINT = '--> statement-breakpoint';

/** The comment lines the assembled file carries (every one starts with `-- accounts-merge:`). */
export const MARKERS = {
  prefix: '-- accounts-merge:',
  generated: '-- accounts-merge:generated',
  preflightBegin: '-- accounts-merge:preflight:begin',
  preflightEnd: '-- accounts-merge:preflight:end',
  phaseBegin: (phase: number): string => `-- accounts-merge:phase:${phase}:begin`,
  phaseEnd: (phase: number): string => `-- accounts-merge:phase:${phase}:end`,
} as const;

/** Where one generated statement goes, and how it is rewritten there. */
export interface StatementPlace {
  /** the phase that runs it */
  readonly phase: number;
  /** true: before the hand-written statements of the phase, false: after them (default: the phase's `generatedFirst`) */
  readonly before?: boolean;
  /** true: `NOT VALID` is appended (a check that existing rows of an append-only table may break, but every new row must keep) */
  readonly notValid?: boolean;
  /** true: the generated `NOT NULL` is left out (the column is filled by a later phase, which sets NOT NULL itself) */
  readonly nullable?: boolean;
}

/** One phase of the assembled file. */
export interface PhaseEntry {
  readonly phase: number;
  readonly name: string;
  /** the hand-written file in `phases/`, or null when the phase holds generated statements only */
  readonly file: string | null;
  /** true: the hand-written file is the preflight block, written between the preflight markers */
  readonly preflight?: boolean;
  /** true: the generated statements of the phase run before its hand-written file (default: after it, so the data moves first) */
  readonly generatedFirst?: boolean;
}

/** The content of `<release>/phase-map.json`. */
export interface PhaseMap {
  readonly release: 'expand' | 'contract';
  /** the end of the migration's file name, after its number */
  readonly migrationSuffix: string;
  /** the comment lines at the top of the assembled file (without `-- `) */
  readonly header: readonly string[];
  readonly phases: readonly PhaseEntry[];
  /** every generated statement by its key ({@link statementKey}) */
  readonly statements: Readonly<Record<string, StatementPlace>>;
}

/** A failure of the assembly; the message says what to fix. */
export class AssembleError extends Error {
  override readonly name = 'AssembleError';
}

const NAME = '"([^"]+)"';

/** The statement shapes drizzle-kit writes, each with the key it gets. */
const SHAPES: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?${NAME}`), (m) => `create-table ${m[1]}`],
  [new RegExp(`^DROP TABLE (?:IF EXISTS )?${NAME}`), (m) => `drop-table ${m[1]}`],
  [new RegExp(`^ALTER TABLE ${NAME} DROP CONSTRAINT (?:IF EXISTS )?${NAME}`), (m) => `drop-constraint ${m[1]}.${m[2]}`],
  [new RegExp(`^ALTER TABLE ${NAME} ADD CONSTRAINT ${NAME}`), (m) => `add-constraint ${m[1]}.${m[2]}`],
  [new RegExp(`^ALTER TABLE ${NAME} ADD COLUMN (?:IF NOT EXISTS )?${NAME}`), (m) => `add-column ${m[1]}.${m[2]}`],
  [new RegExp(`^ALTER TABLE ${NAME} DROP COLUMN (?:IF EXISTS )?${NAME}`), (m) => `drop-column ${m[1]}.${m[2]}`],
  [new RegExp(`^ALTER TABLE ${NAME} ALTER COLUMN ${NAME} DROP NOT NULL`), (m) => `drop-not-null ${m[1]}.${m[2]}`],
  [new RegExp(`^ALTER TABLE ${NAME} ALTER COLUMN ${NAME} SET NOT NULL`), (m) => `set-not-null ${m[1]}.${m[2]}`],
  [new RegExp(`^ALTER TABLE ${NAME} ALTER COLUMN ${NAME} SET DEFAULT`), (m) => `set-default ${m[1]}.${m[2]}`],
  [new RegExp(`^ALTER TABLE ${NAME} ALTER COLUMN ${NAME} DROP DEFAULT`), (m) => `drop-default ${m[1]}.${m[2]}`],
  [new RegExp(`^ALTER TABLE ${NAME} ALTER COLUMN ${NAME} SET DATA TYPE`), (m) => `set-type ${m[1]}.${m[2]}`],
  [
    new RegExp(`^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?${NAME} ON ${NAME}`),
    (m) => `create-index ${m[2]}.${m[1]}`,
  ],
  [new RegExp(`^DROP INDEX (?:IF EXISTS )?${NAME}`), (m) => `drop-index ${m[1]}`],
];

/**
 * The key of a generated statement in the phase map: the kind of statement and the name of what it touches.
 *
 * @param statement one statement as drizzle-kit wrote it
 * @returns for example `add-column orders.account_id` or `drop-constraint clients.clients_status_check`
 * @throws {AssembleError} for a statement of a shape the script does not know
 */
export function statementKey(statement: string): string {
  const text = statement.trim();
  for (const [shape, keyOf] of SHAPES) {
    const match = shape.exec(text);
    if (match) return keyOf(match);
  }
  throw new AssembleError(`A statement of an unknown shape cannot be placed:\n${text}`);
}

/**
 * The chunks of a migration file: the text between two breakpoints, trimmed, without empty ones.
 *
 * @param text the file
 * @returns the chunks in file order
 */
export function chunksOf(text: string): string[] {
  return text
    .split(BREAKPOINT)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '');
}

/**
 * The chunks of a hand-written phase file, split on its own breakpoint lines.
 *
 * @param text the phase file
 * @returns its chunks, trimmed
 */
export function handChunksOf(text: string): string[] {
  return text
    .split(/^--> statement-breakpoint$/m)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '');
}

const withoutMarkers = (chunk: string): string =>
  chunk
    .split('\n')
    .filter((line) => !line.startsWith(MARKERS.prefix))
    .join('\n')
    .trim();

/** The statement as it runs in its phase. */
function placed(statement: string, place: StatementPlace, key: string): string {
  let text = statement;
  if (place.nullable === true) {
    if (!text.endsWith(' NOT NULL;'))
      throw new AssembleError(`${key} is marked nullable but does not end with NOT NULL:\n${text}`);
    text = `${text.slice(0, -' NOT NULL;'.length)};`;
  }
  if (place.notValid === true) {
    if (!text.endsWith(';')) throw new AssembleError(`${key} does not end with a semicolon:\n${text}`);
    text = `${text.slice(0, -1)} NOT VALID;`;
  }
  return text;
}

/** The generated statement back from its placed text (the inverse of {@link placed}). */
function original(text: string, place: StatementPlace | undefined): string {
  let statement = text;
  if (place?.notValid === true && statement.endsWith(' NOT VALID;'))
    statement = `${statement.slice(0, -' NOT VALID;'.length)};`;
  if (place?.nullable === true && !statement.endsWith(' NOT NULL;')) statement = `${statement.slice(0, -1)} NOT NULL;`;
  return statement;
}

/**
 * The statements drizzle-kit generated, read from a migration file: every chunk of a file it wrote, or the marked chunks of a file this
 * script assembled (with the rewrites of their place undone).
 *
 * @param text the migration file
 * @param map the phase map (it says which rewrites to undo)
 * @returns the generated statements, in the order they appear
 */
export function generatedStatementsOf(text: string, map: PhaseMap): string[] {
  const chunks = chunksOf(text);
  const assembled = chunks.some((chunk) => chunk.split('\n').some((line) => line.startsWith(MARKERS.prefix)));
  if (!assembled) return chunks;
  return chunks
    .filter((chunk) => chunk.split('\n').some((line) => line.startsWith(MARKERS.generated)))
    .map((chunk) => {
      const text = withoutMarkers(chunk);
      return original(text, map.statements[statementKey(text)]);
    });
}

/**
 * Assembles the migration: per phase, the generated statements marked `before`, the hand-written file, then the other generated
 * statements, each phase between its markers and the preflight block between its own.
 *
 * @param generated the statements drizzle-kit generated (any order; the order among those of one phase is kept)
 * @param map the phase map of the release
 * @param phaseFiles the text of every hand-written file the map names, by file name
 * @returns the text of the migration file
 * @throws {AssembleError} when a generated statement is not in the map (all of them are listed), a key is generated twice, a phase file
 *   is missing, or a phase would be empty
 */
export function assemble(
  generated: readonly string[],
  map: PhaseMap,
  phaseFiles: Readonly<Record<string, string>>,
): string {
  const keyed = generated.map((statement) => ({ statement: statement.trim(), key: statementKey(statement) }));
  const unknown = keyed.filter(({ key }) => map.statements[key] === undefined);
  if (unknown.length > 0) {
    throw new AssembleError(
      `${unknown.length} generated statement(s) are not in the phase map (add each key to "statements" with its phase):\n` +
        unknown.map(({ key, statement }) => `  ${key}\n    ${statement}`).join('\n'),
    );
  }
  const seen = new Set<string>();
  for (const { key } of keyed) {
    if (seen.has(key))
      throw new AssembleError(`Two generated statements have the key ${key}; the map cannot place them apart.`);
    seen.add(key);
  }
  const phaseNumbers = new Set(map.phases.map((entry) => entry.phase));
  for (const { key } of keyed) {
    if (!phaseNumbers.has(map.statements[key]!.phase)) {
      throw new AssembleError(`${key} is placed in phase ${map.statements[key]!.phase}, which the map does not list.`);
    }
  }

  const chunks: string[] = [];
  for (const entry of [...map.phases].sort((a, b) => a.phase - b.phase)) {
    const ofPhase = keyed.filter(({ key }) => map.statements[key]!.phase === entry.phase);
    const generatedChunk = ({ key, statement }: { key: string; statement: string }) =>
      `${MARKERS.generated} ${key}\n${placed(statement, map.statements[key]!, key)}`;
    let hand: string[] = [];
    if (entry.file !== null) {
      const text = phaseFiles[entry.file];
      if (text === undefined)
        throw new AssembleError(`The phase file ${entry.file} of phase ${entry.phase} is missing.`);
      hand = handChunksOf(text);
      if (entry.preflight === true) {
        if (hand.length !== 1)
          throw new AssembleError(`The preflight file ${entry.file} must hold exactly one statement.`);
        hand = [`${MARKERS.preflightBegin}\n${hand[0]}\n${MARKERS.preflightEnd}`];
      }
    }
    const runsBefore = ({ key }: { key: string }) => map.statements[key]!.before ?? entry.generatedFirst === true;
    const phase = [
      ...ofPhase.filter(runsBefore).map(generatedChunk),
      ...hand,
      ...ofPhase.filter((item) => !runsBefore(item)).map(generatedChunk),
    ];
    if (phase.length === 0) throw new AssembleError(`Phase ${entry.phase} (${entry.name}) would hold no statement.`);
    phase[0] = `${MARKERS.phaseBegin(entry.phase)} ${entry.name}\n${phase[0]}`;
    phase[phase.length - 1] = `${phase[phase.length - 1]}\n${MARKERS.phaseEnd(entry.phase)}`;
    chunks.push(...phase);
  }
  chunks[0] = `${map.header.map((line) => (line === '' ? '--' : `-- ${line}`)).join('\n')}\n${chunks[0]}`;
  return `${chunks.join(`\n${BREAKPOINT}\n`)}\n`;
}

/**
 * The keys of the map that no generated statement has (left over after a schema change): not an error, but worth a look.
 *
 * @param generated the generated statements
 * @param map the phase map
 * @returns the unused keys, sorted
 */
export function unusedKeys(generated: readonly string[], map: PhaseMap): string[] {
  const used = new Set(generated.map((statement) => statementKey(statement)));
  return Object.keys(map.statements)
    .filter((key) => !used.has(key))
    .sort();
}

/** The repository root (this file is scripts/accounts-merge/assemble.ts). */
export const ROOT = resolve(import.meta.dir, '../..');

/**
 * Reads the phase map and the phase files of a release.
 *
 * @param release `expand` or `contract`
 * @param root the repository root
 * @returns the map and the phase files by name
 * @throws {Error} when the release has no phase map yet
 */
export function readRelease(
  release: 'expand' | 'contract',
  root: string = ROOT,
): { map: PhaseMap; phaseFiles: Record<string, string> } {
  const dir = join(root, 'scripts', 'accounts-merge', release);
  const map = JSON.parse(readFileSync(join(dir, 'phase-map.json'), 'utf8')) as PhaseMap;
  const phaseFiles: Record<string, string> = {};
  for (const entry of map.phases) {
    if (entry.file !== null) phaseFiles[entry.file] = readFileSync(join(dir, 'phases', entry.file), 'utf8');
  }
  return { map, phaseFiles };
}

/**
 * The path of the one migration whose name ends with a suffix.
 *
 * @param suffix for example `_accounts_expand.sql`
 * @param root the repository root
 * @returns the absolute path in drizzle/
 * @throws {AssembleError} when no file or more than one ends with it
 */
export function migrationPath(suffix: string, root: string = ROOT): string {
  const folder = join(root, 'drizzle');
  const names = readdirSync(folder).filter((name) => name.endsWith(suffix));
  if (names.length !== 1) {
    throw new AssembleError(
      `Expected one migration ending with ${suffix} in drizzle/, found ${names.length}. Generate it first: bun run db:generate --name ${suffix.slice(1, -'.sql'.length)}`,
    );
  }
  return join(folder, names[0]!);
}

/**
 * Assembles the migration of a release in place.
 *
 * @param release `expand` or `contract`
 * @param root the repository root
 * @returns the path written, how many generated statements it holds, and the map keys no statement used
 */
export function assembleRelease(
  release: 'expand' | 'contract',
  root: string = ROOT,
): { path: string; generated: number; unused: string[] } {
  const { map, phaseFiles } = readRelease(release, root);
  const path = migrationPath(map.migrationSuffix, root);
  const generated = generatedStatementsOf(readFileSync(path, 'utf8'), map);
  const text = assemble(generated, map, phaseFiles);
  writeFileSync(path, text);
  return { path, generated: generated.length, unused: unusedKeys(generated, map) };
}

if (import.meta.main) {
  const release = process.argv[2];
  if (release !== 'expand' && release !== 'contract') {
    console.error('Usage: bun scripts/accounts-merge/assemble.ts <expand|contract>');
    process.exit(1);
  }
  try {
    const { path, generated, unused } = assembleRelease(release);
    console.log(`Assembled ${path} (${generated} generated statements placed).`);
    if (unused.length > 0)
      console.warn(`Keys of the phase map that no generated statement has:\n  ${unused.join('\n  ')}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
