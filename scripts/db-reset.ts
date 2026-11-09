// `bun run db:reset`: a fresh start in development (P4b). Drops and recreates the database of DATABASE_URL, runs the migrations,
// empties the queue and cache Redis databases and the files bucket, then optionally seeds the demo (--seed) or runs the first run
// (--setup: asks for the first admin in a terminal, or takes --email and --name). Development only: refused for production, for
// the test databases and for servers that are not local.
import { type AppConfig, loadConfigOrExit } from '../src/config';
import { PasswordHasher } from '../src/infra/crypto';
import { createDrizzle, createPool } from '../src/infra/db';
import { migrateDatabase } from '../src/infra/db/migrate';
import { FirstRunError, describeFailure } from './first-run';
import {
  RESET_USAGE,
  ResetRefusedError,
  type ResetFirstRun,
  type ResetTarget,
  firstRunOfResetArgs,
  parseResetArgs,
  planReset,
  refuseProductionEnv,
} from './lib/db-reset-plan';
import {
  emptyBucket,
  flushRedisDatabase,
  pingPostgres,
  pingRedis,
  probeBucket,
  recreateDatabase,
} from './lib/db-reset-steps';
import { runFirstRunFlow } from './lib/first-run-flow';
import { readPasswordFromStdin } from './lib/stdin-password';
import { atTerminal, createTerminalPrompter } from './lib/terminal-prompter';
import { seedDevelopmentDatabase } from './seed/dev-seed';
import { demoStatePath } from './seed/demo-state';

/** Prints what is wrong and stops with exit code 1. */
function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

// 1. The command line and the guards, all before anything is touched. The production check reads the raw variable on purpose:
// a production environment must be refused before its (possibly incomplete) configuration is even validated.
let seed: boolean;
let firstRun: ResetFirstRun | undefined;
let config: AppConfig;
let target: ResetTarget;
try {
  const args = parseResetArgs(process.argv.slice(2));
  if (args.help) {
    console.log(RESET_USAGE);
    process.exit(0);
  }
  seed = args.seed;
  refuseProductionEnv(process.env.NODE_ENV);
  // `--seed` reads the frontend's demo state. A missing file must be found here: found inside the seed, the database would be
  // dropped already and left empty.
  if (seed && !(await Bun.file(demoStatePath()).exists())) {
    throw new ResetRefusedError(
      `--seed needs the demo state, which was not found at ${demoStatePath()}. ` +
        'Put the frontend repo next to this one or set FRONTEND_DIR. Nothing was changed.',
    );
  }
  const password = args.passwordStdin ? await readPasswordFromStdin() : undefined;
  // `--setup` with no --email/--name asks questions: that needs a person at the keyboard and the screen, and it is found out here,
  // before anything is dropped.
  firstRun = firstRunOfResetArgs(args, {
    terminal: atTerminal(process.stdin, process.stdout),
    password,
  });
  config = loadConfigOrExit();
  target = planReset(config);
} catch (error) {
  if (error instanceof ResetRefusedError || error instanceof FirstRunError) stop(error.message);
  throw error;
}

// 2. Every server must answer before the first drop, so a stopped Redis or MinIO leaves the data as it was.
let bucketExists = false;
try {
  await pingPostgres(target.adminUrl);
  for (const redis of target.redis) await pingRedis(redis.url);
  bucketExists = await probeBucket(target.bucket);
} catch (error) {
  stop(
    `A server did not answer, so nothing was changed: ${error instanceof Error ? error.message : String(error)}\n` +
      'Start the services with `docker compose up -d` and try again.',
  );
}

// 3. The reset, then what goes into the new database.
let firstRunExit: { code: number; message: string } | undefined;
try {
  console.log(`Resetting "${target.databaseName}" (stop the API and the worker first, and start them again after) ...`);
  await recreateDatabase(target.adminUrl, target.databaseName);
  console.log(`  database   "${target.databaseName}" dropped and created again, empty`);
  await migrateDatabase(target.databaseUrl);
  console.log('  migrations applied');
  for (const redis of target.redis) {
    const where = new URL(redis.url);
    const keys = await flushRedisDatabase(redis.url);
    console.log(`  redis      ${redis.role} Redis ${where.host}${where.pathname || '/0'}: ${keys} keys removed`);
  }
  if (bucketExists) {
    console.log(`  files      bucket "${target.bucket.name}": ${await emptyBucket(target.bucket)} objects removed`);
  } else {
    console.log(`  files      bucket "${target.bucket.name}" does not exist: nothing to empty`);
  }

  if (seed) {
    await seedDevelopmentDatabase(config);
  } else if (firstRun) {
    const pool = createPool(target.databaseUrl, 2);
    try {
      const result = await runFirstRunFlow(createDrizzle(pool), {
        owner: firstRun.owner,
        prompter: firstRun.interactive ? createTerminalPrompter() : undefined,
        now: () => new Date(),
        hasher: new PasswordHasher(config),
        say: (line) => console.log(line),
      });
      if (result.exitCode !== 0)
        firstRunExit = { code: result.exitCode, message: result.error ?? 'The first run stopped.' };
    } finally {
      await pool.end();
    }
  } else {
    console.log('The new database is empty: run `bun run setup` (first run) or `bun run db:seed` (demo data).');
  }
  if (firstRunExit) {
    // The database itself was reset; only the first admin is missing.
    console.error(`${firstRunExit.message} The database was reset: run \`bun run setup\` to create the first admin.`);
    process.exitCode = firstRunExit.code;
  } else {
    console.log('Reset finished.');
  }
} catch (error) {
  console.error(
    `The reset stopped halfway: ${describeFailure(error)}\n` +
      'Fix the cause and run `bun run db:reset` again: it starts from the beginning.',
  );
  process.exitCode = 1;
}
