// `bun run db:check`: fails when the Drizzle schema and the committed migrations disagree (decision 027), without a database.
// It copies drizzle/ to a temp folder, asks drizzle-kit to generate there and fails if that produces a new migration, so
// the committed folder is never touched. Also runs `drizzle-kit check` for the consistency of the snapshot chain.
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const drizzleKit = join(root, 'node_modules/drizzle-kit/bin.cjs');
const work = await mkdtemp(join(tmpdir(), 'gsm-db-check-'));

/** Runs drizzle-kit under Bun with the temp config; returns its exit code and combined output. */
async function kit(...args: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn([process.execPath, drizzleKit, ...args, '--config', join(work, 'drizzle.config.mjs')], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: `${stdout}${stderr}` };
}

const sqlFiles = async (dir: string) => (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();

try {
  await cp(join(root, 'drizzle'), join(work, 'drizzle'), { recursive: true });
  // A plain object is a valid drizzle-kit config; it points at the copy so the committed folder stays untouched.
  // drizzle-kit prefixes `./` to these paths, so they are written relative to the repository root.
  const config = {
    dialect: 'postgresql',
    schema: './src/infra/db/schema.ts',
    out: relative(root, join(work, 'drizzle')),
    casing: 'snake_case',
  };
  await writeFile(join(work, 'drizzle.config.mjs'), `export default ${JSON.stringify(config)};\n`);

  const before = await sqlFiles(join(work, 'drizzle'));
  const consistency = await kit('check');
  if (consistency.code !== 0) {
    console.error(`drizzle-kit check failed:\n${consistency.output}`);
    process.exit(1);
  }
  const generated = await kit('generate', '--name', 'pending_schema_change');
  if (generated.code !== 0) {
    console.error(`drizzle-kit generate failed:\n${generated.output}`);
    process.exit(1);
  }
  const added = (await sqlFiles(join(work, 'drizzle'))).filter((name) => !before.includes(name));
  if (added.length > 0) {
    console.error(
      'The schema has changes that no migration contains. Run `bun run db:generate` and commit the result.',
    );
    for (const name of added)
      console.error(`\n--- ${name} ---\n${await readFile(join(work, 'drizzle', name), 'utf8')}`);
    process.exit(1);
  }
  console.log(`db:check: no drift, ${before.length} migrations match the schema.`);
} finally {
  await rm(work, { recursive: true, force: true });
}
