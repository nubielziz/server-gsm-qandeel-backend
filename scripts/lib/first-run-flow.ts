// The first run as a whole (P4b round 2): the reference data, then the first admin from flags or from questions. Shared by
// `bun run setup` and `bun run db:reset --setup`; the terminal, the clock and the output are parameters so tests drive it.
import type { PasswordHasher } from '../../src/infra/crypto';
import type { Database } from '../../src/infra/db';
import {
  FirstRunError,
  type FirstRunReport,
  NO_ADMIN_HINT,
  type OwnerInput,
  describeFirstAdmin,
  describeReferenceData,
  emailInUse,
  runFirstRun,
} from '../first-run';
import { type Prompter, askFirstAdmin } from './first-admin-prompt';

/** What the flow needs besides the database. */
export interface FirstRunFlowOptions {
  /** The first admin from the command line (`--email`, `--name`): created without questions, in one transaction with the rest. */
  readonly owner?: OwnerInput | undefined;
  /** Set when the run may ask questions (stdin and stdout are terminals); leave out for a script. Ignored when `owner` is set. */
  readonly prompter?: Prompter | undefined;
  /** Reads the clock when a transaction starts. */
  readonly now: () => Date;
  /** Hashes the first admin's password. */
  readonly hasher: PasswordHasher;
  /** Prints one line on standard output. */
  readonly say: (line: string) => void;
}

/** How the flow ended: the exit code, and the message for standard error when it did not go well. */
export interface FirstRunFlowResult {
  /** 0 done (also after answering `n`), 1 refused or bad input, 130 cancelled. */
  readonly exitCode: 0 | 1 | 130;
  readonly error?: string;
}

/** Prints the first admin that a run created; a temporary password goes out here once and nowhere else. */
function sayFirstAdmin(report: FirstRunReport, say: (line: string) => void): void {
  const owner = report.firstOwner;
  if (!owner) return;
  for (const line of describeFirstAdmin(owner)) say(line);
  if (owner.temporaryPassword !== undefined) {
    say(`  Temporary password (shown once, copy it now): ${owner.temporaryPassword}`);
  }
}

/**
 * Runs the first run: the base currency, the 12 system ledger accounts and the Owner role, then the first admin account.
 *
 * Why: `bun run setup` is the one command of a fresh server. The reference data is made first and printed as `✓` lines. The first
 * admin comes from `--email`/`--name` (a script: one transaction with the reference data, so a refusal changes nothing), or, when
 * `prompter` is given and no staff member holds a role that grants every permission, from the questions. The questions come after
 * the reference data is saved, and the account is made by a second `runFirstRun` that re-checks the owner under the advisory lock:
 * an owner made by someone else while the person was typing makes it refuse, with no account created.
 *
 * Side effects: what {@link runFirstRun} writes; prints through `say`; reads the keyboard through the prompter.
 *
 * @param db the Drizzle database (already migrated)
 * @param options the owner from flags or the prompter, the clock, the hasher and the output
 * @returns the exit code and, when it is not 0, the message for standard error
 * @throws {Error} for a failure that is not the operator's to fix (a lost connection, a broken keyboard stream)
 */
export async function runFirstRunFlow(db: Database, options: FirstRunFlowOptions): Promise<FirstRunFlowResult> {
  const { owner, prompter, now, hasher, say } = options;
  try {
    if (owner) {
      const report = await runFirstRun(db, { owner, now: now(), hasher });
      for (const line of describeReferenceData(report)) say(line);
      sayFirstAdmin(report, say);
      return { exitCode: 0 };
    }

    const report = await runFirstRun(db, { now: now(), hasher });
    for (const line of describeReferenceData(report)) say(line);
    if (report.owners > 0) {
      say('✓ Admin account: already there');
      return { exitCode: 0 };
    }
    if (!prompter) {
      say(NO_ADMIN_HINT);
      return { exitCode: 0 };
    }

    say('');
    const answer = await askFirstAdmin({ prompter, emailInUse: (email) => emailInUse(db, email), say });
    switch (answer.status) {
      case 'declined':
        say('No admin account was created. Run `bun run setup` again when you want to create one.');
        return { exitCode: 0 };
      case 'cancelled':
        return { exitCode: 130, error: 'Cancelled: no admin account was created.' };
      case 'gave_up':
        return { exitCode: 1, error: `Too many wrong answers to "${answer.question}": no admin account was created.` };
      case 'answered':
        break;
    }
    const created = await runFirstRun(db, { owner: answer.owner, now: now(), hasher });
    sayFirstAdmin(created, say);
    return { exitCode: 0 };
  } catch (error) {
    // A refusal the operator can act on: an owner appeared meanwhile, the email is taken, a role is misnamed.
    if (error instanceof FirstRunError) return { exitCode: 1, error: error.message };
    throw error;
  }
}
