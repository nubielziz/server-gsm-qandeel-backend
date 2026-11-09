// The first run of a fresh server (P4b): the base currency, the 12 system ledger accounts, the Owner role and, on request, the
// first owner account (with a generated temporary password, or one the person chose). Used by `bun run setup` (scripts/setup.ts) and
// `bun run db:reset --setup` through scripts/lib/first-run-flow.ts. Production-safe and idempotent.
import { randomInt } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { PasswordHasher } from '../src/infra/crypto';
import { type Database, isUniqueViolation, schema as s } from '../src/infra/db';
import {
  EmailField,
  NameField,
  OWNER_ROLE_NAME,
  OWNER_ROLE_PERMISSIONS,
  checkPasswordPolicy,
  grantsEverything,
  temporaryPasswordFor,
} from '../src/modules/identity';
import { countStaffWithEmail, insertStaffRow } from '../src/modules/identity/infra/staff-admin.repository';
import { BASE_CURRENCY_DEFINITION, systemLedgerAccountRows } from '../src/modules/money';
import { AuditService } from '../src/modules/platform';

/**
 * A problem the operator can fix: bad arguments, an owner that already exists, a role name that is taken.
 *
 * Why: the CLI prints the message and exits with code 1, without a stack trace.
 */
export class FirstRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirstRunError';
  }
}

/**
 * The first owner as the operator typed it, already cleaned and checked.
 *
 * Why: with a `password` the person chose it (at the prompt, or on standard input), so it is not temporary: no forced change at the
 * first sign-in. Without one the run generates a temporary password. The password is a secret: never log or print this object.
 */
export interface OwnerInput {
  readonly email: string;
  readonly name: string;
  /** The password the person chose; leave out to get a generated temporary password. */
  readonly password?: string | undefined;
}

/** What `parseSetupArgs` found on the command line. */
export interface SetupArgs {
  readonly email?: string;
  readonly name?: string;
  /** `--password-stdin`: the first owner's password comes from standard input. */
  readonly passwordStdin: boolean;
  readonly help: boolean;
}

/** The usage text of `bun run setup`. */
export const SETUP_USAGE = [
  'Usage: bun run setup [--email <address> --name "<full name>" [--password-stdin]]',
  '',
  '  The one command of the first run. Applies the pending migrations, then creates what a fresh database is missing: the base',
  '  currency (USD), the 12 system ledger accounts and the Owner role. Safe to run again: it creates what is missing and says',
  '  what was already there.',
  '',
  '  In a terminal, when no staff member has a role that grants every permission, it asks for the first admin account: email,',
  '  full name and a password (typed twice, never shown). The first sign-in then asks for the authenticator (TOTP) setup.',
  '',
  '  For a deploy script (no terminal):',
  '  --email, --name   create the first admin without asking. A temporary password is generated and printed once; the first',
  '                    sign-in forces a new password, then asks for the authenticator (TOTP) setup.',
  '  --password-stdin  with --email and --name: read the password from standard input (one line) instead; it is checked with',
  '                    the staff password rules, it is not temporary, and it is not printed.',
  '',
  '  Without a terminal and without --email, no question is asked and no admin is created.',
].join('\n');

/** The commands that read these options: the hint of a refused argument names the one that is running. */
export type FirstRunCommand = 'setup' | 'db:reset';

/**
 * Words the refusal of an argument that is not an option of the command, without repeating the secret it may hold.
 *
 * Why: `setup --password=Hunter2-secret` and `setup -pHunter2` are likely mistakes, and the argument must not come back on the
 * screen, into the scrollback or a deploy log. The text is shown only when it is the name of an option and nothing else: a long
 * option (`--name`, cut at `=`) or one short letter (`-x`). A short option with letters glued to it, a value that starts with a
 * dash and a bare word are not shown at all. A password-like argument points to the safe way (standard input).
 *
 * @param arg the argument as typed
 * @param command the command that is running, named in the password hint
 * @returns the message
 */
function unknownArgumentMessage(arg: string, command: FirstRunCommand): string {
  const name = arg.startsWith('-') ? arg.split('=')[0]! : undefined;
  const shownName = name !== undefined && /^(--[A-Za-z][\w-]*|-[A-Za-z])$/.test(name) ? name : undefined;
  const shown =
    shownName === undefined ? 'Unknown argument (its text is not shown).' : `Unknown argument "${shownName}".`;
  // The hint is chosen from the text but never repeats it, so it is safe for the arguments that are not shown.
  const passwordLike = name !== undefined && (/^-p/.test(name) || /pass/i.test(name));
  const hint = passwordLike
    ? command === 'setup'
      ? ' A password is never taken from the command line: use --password-stdin with --email and --name, or run `bun run setup` in a terminal.'
      : ' A password is never taken from the command line: use --setup with --email, --name and --password-stdin, or run `bun run db:reset --setup` in a terminal.'
    : '';
  return `${shown}${hint} Run with --help for the usage.`;
}

/**
 * Reads `--email`, `--name` (`--flag value` or `--flag=value`) and `--password-stdin` from the command line.
 *
 * Why: `bun run setup` takes only these options; anything else is a typo that must not be ignored silently. A password read from
 * standard input only makes sense for the account that `--email` and `--name` name.
 *
 * @param argv the arguments after the script name
 * @param command the command that is running (`db:reset` passes its own name), so a refusal names the right command
 * @returns the raw values and whether help was asked for
 * @throws {FirstRunError} for an unknown option, a repeated option, an option without a value, or `--password-stdin` without both
 *   `--email` and `--name`
 */
export function parseSetupArgs(argv: readonly string[], command: FirstRunCommand = 'setup'): SetupArgs {
  const values: { email?: string; name?: string } = {};
  let help = false;
  let passwordStdin = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--password-stdin') {
      if (passwordStdin) throw new FirstRunError('--password-stdin was given twice.');
      passwordStdin = true;
      continue;
    }
    const match = /^--(email|name)(?:=(.*))?$/.exec(arg);
    if (!match) throw new FirstRunError(unknownArgumentMessage(arg, command));
    const key = match[1] as 'email' | 'name';
    const value = match[2] ?? argv[++i];
    if (value === undefined || (match[2] === undefined && value.startsWith('--'))) {
      throw new FirstRunError(`--${key} needs a value. Run with --help for the usage.`);
    }
    if (values[key] !== undefined) throw new FirstRunError(`--${key} was given twice.`);
    values[key] = value;
  }
  if (passwordStdin && !help && (values.email === undefined || values.name === undefined)) {
    throw new FirstRunError('--password-stdin needs both --email and --name.');
  }
  return { ...values, passwordStdin, help };
}

/** The answer of a field check: the cleaned value, or the rule the value broke. */
export type FieldCheck = { readonly value: string } | { readonly problem: string };

/**
 * Checks and cleans an email with the rule of `POST /admin/staff`: trimmed, lower-cased, shaped like `a@b.c`, at most 254 characters.
 *
 * Why: the first owner is a staff member like any other. The command line and the prompt share this check, so both give the same
 * answer and the same message.
 *
 * @param raw what the operator typed
 * @returns the cleaned email, or the rule it broke
 */
export function judgeEmail(raw: string): FieldCheck {
  const email = EmailField.safeParse(raw);
  return email.success
    ? { value: email.data }
    : { problem: email.error.issues[0]?.message ?? 'Enter an email address.' };
}

/**
 * Checks and cleans a full name with the rule of `POST /admin/staff`: 2 to 100 characters (judged as typed and trimmed, as the
 * route does), then repeated spaces collapse.
 *
 * @param raw what the operator typed
 * @returns the cleaned name, or the rule it broke
 */
export function judgeName(raw: string): FieldCheck {
  // The same order as the route: the contract judges the trimmed length (2 to 100), then the staff service collapses the spaces.
  const name = NameField.safeParse(raw);
  return name.success
    ? { value: name.data.replace(/\s+/g, ' ') }
    : { problem: name.error.issues[0]?.message ?? 'Enter a name.' };
}

/**
 * Judges a password the person chose for the account, with the staff password policy.
 *
 * Why: the policy refuses a short or trivial password and one that holds the account's email or name. The message never repeats
 * the password.
 *
 * @param password the plain password
 * @param account the email and name it must not contain
 * @returns the rule it broke, or `undefined` when it is acceptable
 */
export function judgePassword(password: string, account: { readonly email: string; readonly name: string }) {
  return checkPasswordPolicy(password, account)?.message;
}

/**
 * Checks the owner's email, name and optional password with the rules of `POST /admin/staff`.
 *
 * Why: the first owner is a staff member like any other, so the same rules apply: the email is trimmed, lower-cased and shaped
 * like `a@b.c` (at most 254 characters); the name loses repeated spaces and has 2 to 100 characters; a password is judged by the
 * staff password policy (it may not contain the email or the name).
 *
 * @param input the raw values; email and name both or neither; a password only with both
 * @returns the cleaned owner, or `undefined` when neither was given
 * @throws {FirstRunError} when only one of the two was given, a value is not acceptable, or a password comes without an owner
 */
export function checkOwnerInput(input: {
  readonly email?: string | undefined;
  readonly name?: string | undefined;
  readonly password?: string | undefined;
}): OwnerInput | undefined {
  if (input.email === undefined && input.name === undefined) {
    if (input.password !== undefined) throw new FirstRunError('A password needs --email and --name.');
    return undefined;
  }
  if (input.email === undefined || input.name === undefined) {
    throw new FirstRunError('Give both --email and --name to create the first owner, or neither.');
  }
  const email = judgeEmail(input.email);
  if ('problem' in email) throw new FirstRunError(`--email: ${email.problem}`);
  const name = judgeName(input.name);
  if ('problem' in name) throw new FirstRunError(`--name: ${name.problem}`);
  if (input.password === undefined) return { email: email.value, name: name.value };
  const problem = judgePassword(input.password, { email: email.value, name: name.value });
  if (problem !== undefined) throw new FirstRunError(`--password-stdin: ${problem}`);
  return { email: email.value, name: name.value, password: input.password };
}

/** What a first run did: what it created and what was already there. */
export interface FirstRunReport {
  readonly currency: { readonly code: string; readonly created: boolean };
  readonly ledgerAccounts: { readonly created: number; readonly existing: number };
  readonly ownerRole: { readonly id: number; readonly name: string; readonly created: boolean };
  /** How many staff members hold a role that grants every permission when the run ends. */
  readonly owners: number;
  /**
   * The first owner, when this run created one. `temporaryPassword` is a secret: print it once, never log it. It is present only
   * for the `temporary_password` onboarding; a `chosen_password` owner has none (the person knows it).
   */
  readonly firstOwner?: {
    readonly id: number;
    readonly name: string;
    readonly email: string;
    readonly onboarding: 'temporary_password' | 'chosen_password';
    readonly temporaryPassword?: string;
  };
}

/** What `runFirstRun` needs besides the database. */
export interface FirstRunOptions {
  /** The first owner to create; leave out to create the reference data only. */
  readonly owner?: OwnerInput | undefined;
  /** The time of the run: stamps the rows it creates (the caller reads the clock). */
  readonly now: Date;
  /** Hashes the owner's password, temporary or chosen (argon2id with the configured cost). */
  readonly hasher: PasswordHasher;
  /** Random source for the temporary password; a test may pass a fixed one. Default: the platform's cryptographic one. */
  readonly pick?: (max: number) => number;
}

/** The lock that serialises two first runs on one database (a fixed key: `hashtext` of a name is not stable across versions). */
const FIRST_RUN_LOCK_KEY = 7_201_090;

/**
 * Creates what a fresh database needs before it can be used, in one transaction.
 *
 * Why: only the development seed made the base currency, the system ledger accounts and an Owner who can sign in; a fresh
 * production database had no way in and could not move money. Each part is skipped when it exists, so the run can be repeated.
 * The first owner is made as `POST /admin/staff` makes a member in its `temporary_password` mode (a generated password kept
 * only as an argon2id hash, a password change forced at the first sign-in, status `invited`, no creator because it is set up
 * outside the console) and, like any new member, enrolls TOTP at the first sign-in (decision 018: two factors are mandatory).
 * When the owner carries a `password` the person chose it: it is kept the same way (only the hash), but it is not temporary, so
 * no change is forced and the first sign-in goes straight to the TOTP enrollment. The owner check runs inside the transaction,
 * under the lock, whatever happened before (an owner made while the person was typing makes the run refuse).
 *
 * Side effects: inserts `currencies`, `ledger_accounts`, `roles`, `staff_users` and one `audit_logs` row per created thing
 * (actor the system, the staff routes' verb phrases; the owner's row says which onboarding was used, never a password or hash);
 * takes an advisory lock for the transaction.
 *
 * @param db the Drizzle database
 * @param options the owner to create, the time and the password hasher
 * @returns what was created and what already existed (for a generated password the report carries it: print it once)
 * @throws {FirstRunError} when an owner already exists and one was requested, when a role called "Owner" lacks full access, when
 *   the owner's email belongs to another staff member, or when a chosen password breaks the staff password policy
 */
export async function runFirstRun(db: Database, options: FirstRunOptions): Promise<FirstRunReport> {
  const { owner, now, hasher } = options;
  const audit = new AuditService();
  const chosenPassword = owner?.password;
  if (owner && chosenPassword !== undefined) {
    // The server is the authority: the prompt and the stdin reader check too, but a caller may not have.
    const problem = judgePassword(chosenPassword, owner);
    if (problem !== undefined) throw new FirstRunError(`The password is not acceptable: ${problem}`);
  }
  const temporaryPassword =
    owner && chosenPassword === undefined
      ? temporaryPasswordFor(options.pick ?? ((max) => randomInt(max)), owner)
      : undefined;
  const secret = chosenPassword ?? temporaryPassword;
  // argon2 takes tens of milliseconds: hash before the transaction opens.
  const passwordHash = secret === undefined ? undefined : await hasher.hash(secret);
  const onboarding = chosenPassword === undefined ? 'temporary_password' : 'chosen_password';

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${FIRST_RUN_LOCK_KEY})`);

    // Staff members whose role grants every permission, of any status: one that never signed in still counts.
    const holders = (
      await tx
        .select({ id: s.staffUsers.id, email: s.staffUsers.email, permissions: s.roles.permissions })
        .from(s.staffUsers)
        .innerJoin(s.roles, eq(s.roles.id, s.staffUsers.roleId))
    ).filter((row) => grantsEverything(row.permissions));
    if (owner && holders.length > 0) {
      throw new FirstRunError(
        'An owner account already exists, so no first owner was created and nothing was changed. ' +
          'Add more staff from the console (Admins & access).',
      );
    }

    // The base currency (decision 011): every ledger account refers to it.
    const [usd] = await tx
      .select({ id: s.currencies.id })
      .from(s.currencies)
      .where(eq(s.currencies.code, BASE_CURRENCY_DEFINITION.code));
    let currencyCreated = false;
    if (!usd) {
      const [created] = await tx
        .insert(s.currencies)
        .values({ ...BASE_CURRENCY_DEFINITION, rateUpdatedAt: now, createdAt: now })
        .returning();
      currencyCreated = true;
      await audit.record(tx, {
        action: 'added currency',
        entityType: 'currency',
        entityId: created!.id,
        entityLabel: created!.code,
        after: { ...BASE_CURRENCY_DEFINITION },
      });
    }

    // The 12 system ledger accounts (decision 024); the unique identity keeps a repeat run from adding any.
    const wanted = systemLedgerAccountRows();
    const opened = await tx.insert(s.ledgerAccounts).values(wanted).onConflictDoNothing().returning();
    for (const account of opened) {
      await audit.record(tx, {
        action: 'opened ledger account',
        entityType: 'ledger_account',
        entityId: account.id,
        entityLabel: account.kind,
        after: { kind: account.kind, currency: account.currency },
      });
    }

    // The Owner role, when no role grants everything (an operator may have renamed it, so the permission decides).
    const allRoles = await tx.select().from(s.roles).orderBy(s.roles.id);
    let ownerRole = allRoles.find((role) => grantsEverything(role.permissions));
    let roleCreated = false;
    if (!ownerRole) {
      if (allRoles.some((role) => role.name.toLowerCase() === OWNER_ROLE_NAME.toLowerCase())) {
        throw new FirstRunError(
          `A role named "${OWNER_ROLE_NAME}" exists but does not grant every permission, and no other role does. ` +
            'Rename it or give it the "*" permission, then run setup again.',
        );
      }
      [ownerRole] = await tx
        .insert(s.roles)
        .values({ name: OWNER_ROLE_NAME, permissions: [...OWNER_ROLE_PERMISSIONS] })
        .returning();
      roleCreated = true;
      await audit.record(tx, {
        action: 'created role',
        entityType: 'role',
        entityId: ownerRole!.id,
        entityLabel: ownerRole!.name,
        after: { name: ownerRole!.name, permissions: ownerRole!.permissions },
      });
    }

    let firstOwner: FirstRunReport['firstOwner'];
    if (owner && passwordHash !== undefined) {
      try {
        const created = await insertStaffRow(tx, {
          email: owner.email,
          name: owner.name,
          roleId: ownerRole!.id,
          status: 'invited',
          passwordHash,
          // A temporary password must be replaced at the first sign-in; one the person chose is theirs already.
          mustChangePassword: onboarding === 'temporary_password',
          passwordChangedAt: now,
          // Set up outside the console: nobody created it (as the demo's "Setup" account).
          createdBy: null,
          createdAt: now,
        });
        await audit.record(tx, {
          action: 'added admin',
          entityType: 'staff',
          entityId: created.id,
          entityLabel: created.name,
          after: {
            name: created.name,
            email: created.email,
            roleId: ownerRole!.id,
            status: 'invited',
            onboarding,
          },
        });
        firstOwner = {
          id: created.id,
          name: created.name,
          email: created.email,
          onboarding,
          ...(temporaryPassword === undefined ? {} : { temporaryPassword }),
        };
      } catch (error) {
        if (isUniqueViolation(error, 'staff_users_email_uq')) {
          throw new FirstRunError(
            'A staff member with this email address already exists, and none of them is an owner.',
          );
        }
        throw error;
      }
    }

    return {
      currency: { code: BASE_CURRENCY_DEFINITION.code, created: currencyCreated },
      ledgerAccounts: { created: opened.length, existing: wanted.length - opened.length },
      ownerRole: { id: ownerRole!.id, name: ownerRole!.name, created: roleCreated },
      owners: holders.length + (firstOwner ? 1 : 0),
      ...(firstOwner ? { firstOwner } : {}),
    };
  });
}

/**
 * Writes what a run did to the reference data as `✓` lines for the terminal.
 *
 * Why: the operator reads what was created and what already existed, one line per part (the transcript the project owner approved).
 *
 * @param report the result of {@link runFirstRun}
 * @returns the lines
 */
export function describeReferenceData(report: FirstRunReport): string[] {
  const { created, existing } = report.ledgerAccounts;
  const accounts =
    existing === 0 ? 'created' : created === 0 ? 'already there' : `${created} created, ${existing} already there`;
  const role = report.ownerRole.name === OWNER_ROLE_NAME ? '' : ` (${report.ownerRole.name})`;
  return [
    `✓ Base currency ${report.currency.code}: ${report.currency.created ? 'created' : 'already there'}`,
    `✓ ${created + existing} system ledger accounts: ${accounts}`,
    `✓ Owner role${role}: ${report.ownerRole.created ? 'created' : 'already there'}`,
  ];
}

/**
 * Writes the line about the first admin account that a run just created: never a password.
 *
 * @param owner the `firstOwner` of the report
 * @returns the lines; a temporary password goes out separately, once, from the caller
 */
export function describeFirstAdmin(owner: NonNullable<FirstRunReport['firstOwner']>): string[] {
  return owner.onboarding === 'chosen_password'
    ? [`✓ First admin created: ${owner.email}`, '  Sign in at the console; you will set up 2FA (TOTP) first.']
    : [
        `✓ First admin created: ${owner.email}`,
        '  Sign in at the console with the temporary password below, choose a new password, then set up 2FA (TOTP).',
      ];
}

/** The line that tells how to create the first admin later, for a run that created none. */
export const NO_ADMIN_HINT =
  'No admin account yet. Run `bun run setup` in a terminal to create the first one, ' +
  'or give --email and --name (and --password-stdin to read the password from standard input).';

/**
 * Tells whether a staff member already uses an email (any case).
 *
 * Why: the prompt refuses a taken email at its own question, before the person types a password, instead of at the insert.
 *
 * @param db the Drizzle database
 * @param email the cleaned email
 * @returns true when another account has it
 */
export async function emailInUse(db: Database, email: string): Promise<boolean> {
  return (await countStaffWithEmail(db, email)) > 0;
}

/**
 * Writes a failure of a first run as one message for the terminal, without the failed query.
 *
 * Why: Drizzle's error message repeats the SQL and its parameters, and the failed insert may be the owner's, whose parameters hold the
 * password hash. The operator needs the cause (Postgres's own message), not the parameters; a missing table says to migrate.
 *
 * @param error anything thrown by {@link runFirstRun} or the connection
 * @returns the message to print
 */
export function describeFailure(error: unknown): string {
  if (error instanceof FirstRunError) return error.message;
  const cause = (error as { cause?: unknown }).cause;
  const code = (cause as { code?: string } | undefined)?.code ?? (error as { code?: string }).code;
  // 42P01 is "relation does not exist": the migrations have not run.
  if (code === '42P01') return 'The tables do not exist yet. Run `bun run db:migrate` first.';
  if (cause instanceof Error) return cause.message;
  return error instanceof Error ? (error.message.split('\n')[0] ?? 'Unknown error.') : String(error);
}
