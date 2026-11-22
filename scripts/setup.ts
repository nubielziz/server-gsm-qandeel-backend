// `bun run setup`: the one command of the first run on a fresh server (P4b). Applies the pending migrations, creates the base
// currency, the system ledger accounts and the Owner role, then the first admin: asked for in a terminal, or from --email and --name.
// Allowed in production; safe to repeat. It connects as the owner of the tables and then sets the application role's privileges (decision 055):
// run it in the migrate service in production (it holds DATABASE_OWNER_URL).
import { loadConfigOrExit } from '../src/config';
import { PasswordHasher } from '../src/infra/crypto';
import { createDrizzle, createPool } from '../src/infra/db';
import { applyApplicationGrants } from '../src/infra/db/grants';
import { migrateDatabase } from '../src/infra/db/migrate';
import { databaseUrlFor, ownerUrlFor } from '../src/infra/db/url';
import {
  FirstRunError,
  type OwnerInput,
  SETUP_USAGE,
  checkOwnerInput,
  describeFailure,
  parseSetupArgs,
} from './first-run';
import { runFirstRunFlow } from './lib/first-run-flow';
import { readPasswordFromStdin } from './lib/stdin-password';
import { atTerminal, createTerminalPrompter } from './lib/terminal-prompter';

// Bad arguments are reported before the configuration is read: a typo should not need a complete environment to be found.
let owner: OwnerInput | undefined;
try {
  const args = parseSetupArgs(process.argv.slice(2));
  if (args.help) {
    console.log(SETUP_USAGE);
    process.exit(0);
  }
  const password = args.passwordStdin ? await readPasswordFromStdin() : undefined;
  owner = checkOwnerInput({ email: args.email, name: args.name, password });
} catch (error) {
  if (!(error instanceof FirstRunError)) throw error;
  console.error(error.message);
  process.exit(1);
}

// Questions only when nothing names the owner and a person is at the keyboard and the screen.
const interactive = owner === undefined && atTerminal(process.stdin, process.stdout);

const config = loadConfigOrExit();
if (config.isProduction && config.database.ownerUrl === undefined) {
  console.error(
    "setup in production needs DATABASE_OWNER_URL (the owner role of the tables); DATABASE_URL is the application's own role: run it in the migrate service (docs/OPERATIONS.md section 2).",
  );
  process.exit(1);
}
const ownerUrl = ownerUrlFor(config);
const appUrl = databaseUrlFor(config);

try {
  const applied = await migrateDatabase(ownerUrl);
  console.log(applied === 0 ? '✓ Migrations: up to date' : `✓ Migrations: ${applied} applied`);
} catch (error) {
  console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

try {
  const grants = await applyApplicationGrants(ownerUrl, appUrl);
  if (grants.kind === 'same_role') {
    if (config.isProduction) {
      console.error(
        '✗ DATABASE_URL and DATABASE_OWNER_URL name the same role: in production the application connects with a role of its own (docs/OPERATIONS.md section 2).',
      );
      process.exit(1);
    }
    console.log(`✓ The application connects as the owner role ${grants.role}: no grants applied`);
  } else {
    console.log(
      `✓ Application role ${grants.role}: ${grants.created ? 'created' : 'updated'}; privileges set on ${grants.tables} tables (no UPDATE or DELETE on the 4 append-only tables)`,
    );
  }
} catch (error) {
  console.error(`✗ Grants failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// The first run writes with the owner connection; the application role is for the API and the worker only.
const pool = createPool(ownerUrl, 2);
try {
  const result = await runFirstRunFlow(createDrizzle(pool), {
    owner,
    prompter: interactive ? createTerminalPrompter() : undefined,
    now: () => new Date(),
    hasher: new PasswordHasher(config),
    say: (line) => console.log(line),
  });
  if (result.error !== undefined) console.error(result.error);
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(describeFailure(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
