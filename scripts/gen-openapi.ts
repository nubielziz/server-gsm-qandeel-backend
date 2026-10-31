// Writes docs/contract/openapi.json (every route) and openapi.public.json (REST v1, Dhru, events) from the contracts.
// Builds the Nest app WITHOUT init() or listen(): no Postgres, Redis or S3 needed. `--check` exits 1 on any difference.
// Usage: `bun run docs:openapi`, `bun run docs:openapi:check` in CI (decisions 008, 009, 017); `--dir <path>` for tests.
import 'reflect-metadata';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { AppModule } from '../src/app.module';
import { ENV_VARIABLES, parseEnv } from '../src/config';
import { buildOpenApiDocuments, serializeOpenApiDocument } from '../src/modules/platform';
import { createOfflineApp } from './lib/create-offline-app';

const ROOT = resolve(import.meta.dir, '..');
const FILES = { internal: 'openapi.json', public: 'openapi.public.json' } as const;

/** Reads `--check` and `--dir <path>`; anything else is a usage error. */
function parseArguments(argv: readonly string[]): { check: boolean; dir: string } {
  let check = false;
  let dir = join(ROOT, 'docs', 'contract');
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--check') check = true;
    else if (argument === '--dir' && argv[i + 1] !== undefined) dir = resolve(argv[++i] ?? dir);
    else throw new Error(`Unknown argument "${argument}". Usage: gen-openapi.ts [--check] [--dir <folder>]`);
  }
  return { check, dir };
}

/** Says where two texts first differ, so a failed `--check` shows what changed without a diff tool. */
function describeDifference(committed: string, generated: string): string {
  const a = committed.split('\n');
  const b = generated.split('\n');
  const line = a.findIndex((text, index) => text !== b[index]);
  const at = line === -1 ? Math.min(a.length, b.length) : line;
  return `first difference at line ${at + 1}: committed ${JSON.stringify(a[at] ?? '(end of file)')}, generated ${JSON.stringify(b[at] ?? '(end of file)')}`;
}

async function main(): Promise<number> {
  const { check, dir } = parseArguments(process.argv.slice(2));

  // The documents must not depend on the machine's settings: start from a clean environment, as the tests do.
  for (const name of ENV_VARIABLES) delete process.env[name];
  process.env.NODE_ENV = 'test';
  const config = parseEnv({ NODE_ENV: 'test' });

  // No Postgres, Redis or S3 is needed: a provider that connects while the app is created fails the generator. The
  // helper also waits one event-loop turn, because ioredis and BullMQ open their socket on process.nextTick.
  const { value: documents, attempts } = await createOfflineApp(AppModule, config, (app) => buildOpenApiDocuments(app));
  if (attempts.length > 0) {
    console.error(`The application tried to open ${attempts.length} network connection(s) while it was being created:`);
    for (const attempt of attempts) console.error(`  ${attempt}`);
    console.error('Constructors must not connect: connect in onModuleInit (docs/briefs/P2.4-infra.md).');
    return 1;
  }
  const generated = {
    [FILES.internal]: serializeOpenApiDocument(documents.internal),
    [FILES.public]: serializeOpenApiDocument(documents.public),
  };

  if (!check) {
    await mkdir(dir, { recursive: true });
    for (const [name, text] of Object.entries(generated)) {
      await writeFile(join(dir, name), text);
      console.log(`wrote ${relative(ROOT, join(dir, name))}`);
    }
    return 0;
  }

  let stale = 0;
  for (const [name, text] of Object.entries(generated)) {
    const file = relative(ROOT, join(dir, name));
    const committed = await readFile(join(dir, name), 'utf8').catch(() => undefined);
    if (committed === undefined) {
      console.error(`${file} is missing.`);
      stale++;
    } else if (committed !== text) {
      console.error(`${file} is out of date: ${describeDifference(committed, text)}.`);
      stale++;
    } else {
      console.log(`${file} is up to date.`);
    }
  }
  if (stale > 0) console.error('Run `bun run docs:openapi` and commit the regenerated documents.');
  return stale > 0 ? 1 : 0;
}

// Exit explicitly: the Nest application was never initialised, so it is not closed (closing would run shutdown hooks
// of connections that were never opened).
main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(2);
  },
);
