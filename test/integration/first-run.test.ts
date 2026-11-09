// The first run on a fresh server (P4b): `runFirstRun` on an empty database (what it creates, the audit rows, idempotency, the
// refusals, a race), the whole flow with a fake prompter (the questions of round 2), and `bun run setup` as a command, also in a
// pseudo-terminal: the printed temporary password and the chosen password both sign in through the real routes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { parseEnv } from '../../src/config';
import { PasswordHasher } from '../../src/infra/crypto';
import { IpRuleCache } from '../../src/modules/identity';
import type { LedgerAccountKind } from '../../src/modules/money/db/schema';
import { schema as s } from '../../src/infra/db';
import {
  FirstRunError,
  type FirstRunReport,
  NO_ADMIN_HINT,
  type OwnerInput,
  describeReferenceData,
  runFirstRun,
} from '../../scripts/first-run';
import type { Prompter } from '../../scripts/lib/first-admin-prompt';
import { runFirstRunFlow } from '../../scripts/lib/first-run-flow';
import { demoStatePath } from '../../scripts/seed/demo-state';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, clearRateLimits, insertRole, insertStaff } from '../support/auth';
import { TestClock } from '../support/clock';
import { TEST_DATABASE_URL, closeTestDb, resetDb, testDb } from '../support/db';
import { testInstanceEnv } from '../support/env';
import { freshClientIp } from '../support/pipeline-routes';
import { expectRejection } from '../support/rejection';
import { CONSOLE_ORIGIN, StaffConsole, codeFor } from '../support/staff-console';
import { referenceRows } from '../support/seed-reference';
import { runInTerminal } from '../support/terminal-session';

const config = parseEnv({ NODE_ENV: 'test', DATABASE_URL_TEST: TEST_DATABASE_URL, ...testInstanceEnv() });
const hasher = new PasswordHasher(config);
const clock = new TestClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: CONSOLE_ORIGIN }, clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  // Staff ids start again at 1 after every reset, and the sign-in limiter counts per account for 15 minutes in Redis: without this
  // the Nth enrollment of "staff 1" (in this run or the one before) meets a lock.
  await clearRateLimits(t);
  // Another file may have left its IP rules snapshot in the shared cache Redis (the demo seed's admin allowlist refuses the sign-ins
  // of the tests below with IP_NOT_ALLOWED); the database was just emptied, so the next request loads no rules (test/README.md).
  await t.app.get(IpRuleCache).invalidate();
});

/** A first-owner input with an email no earlier run used (the sign-in limiter keeps counters in Redis between runs). */
const newOwner = () => ({ email: `owner-${randomUUID().slice(0, 8)}@example.com`, name: 'Layla Haddad' });

async function run(owner?: OwnerInput): Promise<FirstRunReport> {
  const { db } = await testDb();
  return runFirstRun(db, { owner, now: clock.now(), hasher });
}

async function tableCounts() {
  const { db } = await testDb();
  const one = async (query: Promise<Array<{ n: number }>>) => (await query)[0]!.n;
  return {
    currencies: await one(db.select({ n: sql<number>`count(*)::int` }).from(s.currencies)),
    accounts: await one(db.select({ n: sql<number>`count(*)::int` }).from(s.ledgerAccounts)),
    roles: await one(db.select({ n: sql<number>`count(*)::int` }).from(s.roles)),
    staff: await one(db.select({ n: sql<number>`count(*)::int` }).from(s.staffUsers)),
    audit: await one(db.select({ n: sql<number>`count(*)::int` }).from(s.auditLogs)),
  };
}

describe('runFirstRun on an empty database', () => {
  it('creates USD, the 12 system accounts, the Owner role and the first owner with a forced password change', async () => {
    const owner = newOwner();
    const report = await run(owner);
    const { db } = await testDb();

    const currencies = await db.select().from(s.currencies);
    expect(currencies).toHaveLength(1);
    expect(currencies[0]).toMatchObject({
      code: 'USD',
      name: 'US dollar',
      rateToBase: '1.00000000',
      markupPercent: '0.0000',
      charmRounding: false,
      isStorefront: true,
      decimals: 2,
      isActive: true,
    });
    expect(currencies[0]!.rateUpdatedAt).toEqual(clock.now());

    const accounts = await db.select().from(s.ledgerAccounts).orderBy(asc(s.ledgerAccounts.id));
    const kinds: LedgerAccountKind[] = [
      'adjustments',
      'bank',
      'chargeback_loss',
      'cogs',
      'commission_expense',
      'customer_funds',
      'fee_income',
      'gateway_clearing',
      'gateway_fees',
      'owner_capital',
      'revenue',
      'vat_payable',
    ];
    expect(accounts.map((account) => account.kind).sort()).toEqual(kinds);
    expect(accounts.every((account) => account.currency === 'USD' && account.ownerType === null)).toBe(true);
    expect(accounts.every((account) => account.balance === '0.0000' && account.version === 0)).toBe(true);

    const roles = await db.select().from(s.roles);
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ name: 'Owner', permissions: ['*'] });

    const staff = await db.select().from(s.staffUsers);
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({
      email: owner.email,
      name: owner.name,
      roleId: roles[0]!.id,
      // As POST /admin/staff makes a member in its temporary_password mode: invited, a password change forced.
      status: 'invited',
      mustChangePassword: true,
      twofaEnabled: false,
      totpSecretEnc: null,
      createdBy: null,
      lastLoginAt: null,
    });
    expect(staff[0]!.passwordChangedAt).toEqual(clock.now());
    // Only the argon2id hash is stored, never the password.
    expect(staff[0]!.passwordHash).toStartWith('$argon2id$');
    expect(staff[0]!.passwordHash).not.toContain(report.firstOwner!.temporaryPassword!);

    expect(report).toMatchObject({
      currency: { code: 'USD', created: true },
      ledgerAccounts: { created: 12, existing: 0 },
      ownerRole: { id: roles[0]!.id, name: 'Owner', created: true },
      owners: 1,
      firstOwner: { id: staff[0]!.id, name: owner.name, email: owner.email, onboarding: 'temporary_password' },
    });
    expect(report.firstOwner!.temporaryPassword!.length).toBeGreaterThanOrEqual(10);
  });

  it('writes one audit row per created thing: actor the system, the staff routes verb phrases, no secret', async () => {
    const report = await run(newOwner());
    const { db } = await testDb();
    const rows = await db.select().from(s.auditLogs).orderBy(asc(s.auditLogs.id));
    expect(rows).toHaveLength(1 + 12 + 1 + 1);
    expect(rows.every((row) => row.actorType === 'system' && row.actorId === null && row.actorName === '')).toBe(true);

    const summary = (action: string, entityType: string) =>
      rows.filter((row) => row.action === action && row.entityType === entityType);
    expect(summary('added currency', 'currency').map((row) => row.entityLabel)).toEqual(['USD']);
    expect(summary('opened ledger account', 'ledger_account')).toHaveLength(12);
    expect(summary('created role', 'role').map((row) => row.entityLabel)).toEqual(['Owner']);
    const staffRows = summary('added admin', 'staff');
    expect(staffRows).toHaveLength(1);
    expect(staffRows[0]).toMatchObject({
      entityId: report.firstOwner!.id,
      entityLabel: 'Layla Haddad',
      after: { onboarding: 'temporary_password', status: 'invited' },
    });
    // The temporary password and its hash appear in no row.
    const text = JSON.stringify(rows);
    expect(text).not.toContain(report.firstOwner!.temporaryPassword!);
    expect(text).not.toContain('$argon2');
  });

  it('is idempotent: a second run creates nothing, says what was there, and writes no audit row', async () => {
    await run(newOwner());
    const before = await tableCounts();
    const second = await run();
    expect(await tableCounts()).toEqual(before);
    expect(second).toMatchObject({
      currency: { created: false },
      ledgerAccounts: { created: 0, existing: 12 },
      ownerRole: { created: false },
      owners: 1,
    });
    expect(second.firstOwner).toBeUndefined();
  });

  it('refuses a second owner while one exists, whatever its status or its role is called, and changes nothing', async () => {
    const owner = newOwner();
    await run(owner);
    const { db } = await testDb();
    const before = await tableCounts();
    const refusal = await expectRejection(run(newOwner()), FirstRunError);
    expect((refusal as Error).message).toMatch(/Admins & access/);
    expect(await tableCounts()).toEqual(before);

    // A suspended owner, and a role renamed away from "Owner": the permission decides, not the status or the name.
    await db.update(s.staffUsers).set({ status: 'suspended' });
    await db.update(s.roles).set({ name: 'Chief' });
    await expectRejection(run(newOwner()), FirstRunError);
    expect(await tableCounts()).toEqual(before);
  });

  it('creates the reference data alone without an owner, and an owner can be added by a later run', async () => {
    const first = await run();
    expect(first).toMatchObject({ owners: 0, ledgerAccounts: { created: 12 }, ownerRole: { created: true } });
    expect(first.firstOwner).toBeUndefined();
    expect((await tableCounts()).staff).toBe(0);

    const later = await run(newOwner());
    expect(later).toMatchObject({
      currency: { created: false },
      ledgerAccounts: { created: 0, existing: 12 },
      ownerRole: { created: false },
      owners: 1,
    });
    expect(later.firstOwner).toBeDefined();
  });

  it('completes partial reference data and audits only what it created: USD alone, then 5 of the 12 accounts missing', async () => {
    const { db } = await testDb();
    await run();

    // Only USD and the Owner role are left: all 12 accounts are made again, one audit row each, and USD is not audited twice.
    await db.delete(s.ledgerAccounts);
    const auditBeforeRebuild = (await tableCounts()).audit;
    const rebuilt = await run();
    expect(rebuilt).toMatchObject({
      currency: { created: false },
      ledgerAccounts: { created: 12, existing: 0 },
      ownerRole: { created: false },
    });
    expect(await tableCounts()).toMatchObject({
      currencies: 1,
      accounts: 12,
      roles: 1,
      audit: auditBeforeRebuild + 12,
    });

    // Five of the 12 are missing: the identity of an account (kind, currency, owner) is unique, so the other 7 are left alone and
    // only the 5 new ones are reported and audited.
    const accounts = await db.select().from(s.ledgerAccounts).orderBy(asc(s.ledgerAccounts.id));
    const missing = accounts.slice(0, 5);
    await db.delete(s.ledgerAccounts).where(
      inArray(
        s.ledgerAccounts.id,
        missing.map((account) => account.id),
      ),
    );
    const auditBeforePartial = (await tableCounts()).audit;
    const partial = await run();
    expect(partial.ledgerAccounts).toEqual({ created: 5, existing: 7 });
    expect(describeReferenceData(partial)[1]).toBe('✓ 12 system ledger accounts: 5 created, 7 already there');
    expect(await tableCounts()).toMatchObject({ accounts: 12, audit: auditBeforePartial + 5 });
    const opened = await db
      .select({ label: s.auditLogs.entityLabel })
      .from(s.auditLogs)
      .where(eq(s.auditLogs.action, 'opened ledger account'))
      .orderBy(sql`${s.auditLogs.id} desc`)
      .limit(5);
    expect(opened.map((row) => row.label).sort()).toEqual(missing.map((account) => account.kind).sort());
  });

  it('lets the operator remove an owner who never signed in and run setup again (the README recovery)', async () => {
    const { db } = await testDb();
    await run(newOwner());
    // The README: delete the never-used account with SQL, then run setup with the owner options again.
    await db.delete(s.staffUsers);
    const again = await run(newOwner());
    expect(again).toMatchObject({ currency: { created: false }, ownerRole: { created: false }, owners: 1 });
    expect(again.firstOwner).toBeDefined();
    expect((await tableCounts()).staff).toBe(1);
  });

  it('uses a role that already grants every permission instead of creating "Owner"', async () => {
    const { db } = await testDb();
    const chief = await insertRole(db, ['*'], 'Chief');
    const report = await run(newOwner());
    expect(report.ownerRole).toEqual({ id: chief, name: 'Chief', created: false });
    expect(await db.select().from(s.roles)).toHaveLength(1);
    const [row] = await db.select().from(s.staffUsers);
    expect(row!.roleId).toBe(chief);
  });

  it('refuses a role called "Owner" that lacks full access, and rolls everything back', async () => {
    const { db } = await testDb();
    await insertRole(db, ['orders:read'], 'owner');
    await expectRejection(run(newOwner()), /does not grant every permission/);
    const counts = await tableCounts();
    expect(counts).toMatchObject({ currencies: 0, accounts: 0, staff: 0, audit: 0 });
  });

  it('refuses an email that belongs to another staff member, and rolls everything back', async () => {
    const { db } = await testDb();
    const limited = await insertRole(db, ['orders:read']);
    await insertStaff(db, limited, { email: 'taken@example.com' });
    await expectRejection(run({ email: 'Taken@Example.com', name: 'Layla Haddad' }), /already exists/);
    expect(await tableCounts()).toMatchObject({ currencies: 0, accounts: 0, roles: 1, staff: 1, audit: 0 });
  });

  it('lets exactly one of two parallel first runs create the owner', async () => {
    const results = await Promise.allSettled([run(newOwner()), run(newOwner())]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(FirstRunError);
    expect(await tableCounts()).toMatchObject({ currencies: 1, accounts: 12, roles: 1, staff: 1, audit: 15 });
  });
});

/** Signs in as the new owner through the real routes and completes the 2FA enrollment every new member goes through. */
async function signInAndEnroll(email: string, password: string) {
  clock.reset();
  const console = new StaffConsole(t, freshClientIp());
  // A password the person chose is not temporary: the answer goes straight to the TOTP enrollment (no `password` step).
  expect((await console.login(email, password)).json()).toEqual({ next: 'totp_setup' });
  const { secret } = (await console.setup()).json<{ secret: string }>();
  expect((await console.code(await codeFor(secret, clock.nowMs()))).statusCode).toBe(204);
  const me = (await console.me()).json<Record<string, unknown>>();
  expect(me).toMatchObject({
    email,
    status: 'active',
    role: { name: 'Owner' },
    permissions: ['*'],
    twofaEnabled: true,
    mustChangePassword: false,
  });
  return me;
}

const CHOSEN_PASSWORD = 'a-long-passphrase-4U';

describe('runFirstRun with a password the person chose', () => {
  it('stores only the hash, forces no change, keeps the status invited, and the owner signs in straight to the TOTP setup', async () => {
    const owner = { ...newOwner(), password: CHOSEN_PASSWORD };
    const report = await run(owner);
    const { db } = await testDb();
    const [row] = await db.select().from(s.staffUsers);
    expect(row).toMatchObject({
      email: owner.email,
      status: 'invited',
      mustChangePassword: false,
      twofaEnabled: false,
      createdBy: null,
    });
    expect(row!.passwordChangedAt).toEqual(clock.now());
    expect(row!.passwordHash).toStartWith('$argon2id$');
    expect(row!.passwordHash).not.toContain(CHOSEN_PASSWORD);
    // Nothing temporary was generated.
    expect(report.firstOwner).toMatchObject({ onboarding: 'chosen_password' });
    expect(report.firstOwner!.temporaryPassword).toBeUndefined();

    const me = await signInAndEnroll(owner.email, CHOSEN_PASSWORD);
    expect(me.name).toBe(owner.name);
  });

  it('says in the audit row which onboarding was used, and holds neither the password nor its hash anywhere', async () => {
    const owner = { ...newOwner(), password: CHOSEN_PASSWORD };
    await run(owner);
    const { db } = await testDb();
    const rows = await db.select().from(s.auditLogs).orderBy(asc(s.auditLogs.id));
    expect(rows).toHaveLength(15);
    const [added] = rows.filter((row) => row.action === 'added admin');
    expect(added!.after).toMatchObject({ onboarding: 'chosen_password', status: 'invited' });
    const [staff] = await db.select({ hash: s.staffUsers.passwordHash }).from(s.staffUsers);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(CHOSEN_PASSWORD);
    expect(text).not.toContain(staff!.hash);
    expect(text).not.toContain('$argon2');
  });

  it('refuses a password the staff policy refuses (short, trivial, holding the email or the name) and creates nothing', async () => {
    const owner = newOwner();
    for (const password of ['short', 'password1234', `${owner.email.split('@')[0]}-9x`, 'haddad-and-more-9']) {
      const refusal = await expectRejection(run({ ...owner, password }), FirstRunError);
      expect((refusal as Error).message).not.toContain(password);
    }
    expect(await tableCounts()).toEqual({ currencies: 0, accounts: 0, roles: 0, staff: 0, audit: 0 });
  });
});

/** What the fake prompter answers: a text, `null` for a cancel, or a function that may do something first (the race). */
type Reply = string | null | (() => Promise<string | null>);

/** A prompter that answers from a script and records the questions. */
function scripted(replies: Reply[]) {
  const questions: string[] = [];
  const next = async (question: string): Promise<string | null> => {
    questions.push(question.trim());
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`The script ran out of answers at "${question.trim()}".`);
    return typeof reply === 'function' ? reply() : reply;
  };
  const prompter: Prompter = { ask: next, askHidden: next };
  return { prompter, questions };
}

async function flow(options: { owner?: { email: string; name: string }; prompter?: Prompter }) {
  const { db } = await testDb();
  const said: string[] = [];
  const result = await runFirstRunFlow(db, {
    ...options,
    now: () => clock.now(),
    hasher,
    say: (line) => said.push(line),
  });
  return { result, said };
}

describe('the first run flow with a fake prompter', () => {
  it('asks the questions of the approved transcript, creates the admin, and the chosen password signs in', async () => {
    const email = newOwner().email;
    const { prompter, questions } = scripted(['', email, 'Layla  Haddad', CHOSEN_PASSWORD, CHOSEN_PASSWORD]);
    const { result, said } = await flow({ prompter });
    expect(result).toEqual({ exitCode: 0 });
    expect(said).toEqual([
      '✓ Base currency USD: created',
      '✓ 12 system ledger accounts: created',
      '✓ Owner role: created',
      '',
      `✓ First admin created: ${email}`,
      '  Sign in at the console; you will set up 2FA (TOTP) first.',
    ]);
    expect(questions).toEqual([
      'No admin account yet. Create the first one now? [Y/n]',
      'Email:',
      'Full name:',
      'Password:',
      'Repeat password:',
    ]);
    expect(said.join('\n')).not.toContain(CHOSEN_PASSWORD);
    expect(await tableCounts()).toMatchObject({ currencies: 1, accounts: 12, roles: 1, staff: 1, audit: 15 });
    const me = await signInAndEnroll(email, CHOSEN_PASSWORD);
    expect(me.name).toBe('Layla Haddad');
  });

  it('answering n finishes without an admin and says how to make one later', async () => {
    const { prompter, questions } = scripted(['n']);
    const { result, said } = await flow({ prompter });
    expect(result).toEqual({ exitCode: 0 });
    expect(said.at(-1)).toContain('Run `bun run setup` again');
    expect(questions).toHaveLength(1);
    expect(await tableCounts()).toMatchObject({ currencies: 1, accounts: 12, roles: 1, staff: 0 });
  });

  it('turns Ctrl+C or the end of the input at any question into exit code 130 with no admin created', async () => {
    const answers: Reply[] = ['', newOwner().email, 'Layla Haddad', CHOSEN_PASSWORD, CHOSEN_PASSWORD];
    for (let cancelAt = 0; cancelAt < answers.length; cancelAt++) {
      const { prompter } = scripted([...answers.slice(0, cancelAt), null]);
      const { result } = await flow({ prompter });
      expect(result).toEqual({ exitCode: 130, error: 'Cancelled: no admin account was created.' });
      expect((await tableCounts()).staff).toBe(0);
    }
  });

  it('gives up after three bad answers with exit code 1 and no admin created', async () => {
    const { prompter } = scripted(['', 'nope', 'still not', 'no @ here']);
    const { result, said } = await flow({ prompter });
    expect(result).toEqual({
      exitCode: 1,
      error: 'Too many wrong answers to "Email": no admin account was created.',
    });
    expect(said.filter((line) => line.includes('✗'))).toHaveLength(3);
    expect((await tableCounts()).staff).toBe(0);
  });

  it('finds a taken email by a read before the password questions, and a staff member who is not an owner does not stop the questions', async () => {
    const { db } = await testDb();
    const limited = await insertRole(db, ['orders:read']);
    await insertStaff(db, limited, { email: 'taken@example.com' });
    const email = newOwner().email;
    const { prompter, questions } = scripted([
      '',
      'Taken@Example.com',
      email,
      'Layla Haddad',
      CHOSEN_PASSWORD,
      CHOSEN_PASSWORD,
    ]);
    const { result, said } = await flow({ prompter });
    expect(result).toEqual({ exitCode: 0 });
    expect(said).toContain('  ✗ This email address already belongs to another staff member.');
    expect(questions.indexOf('Password:')).toBeGreaterThan(questions.lastIndexOf('Email:'));
    expect((await tableCounts()).staff).toBe(2);
  });

  it('refuses, with nothing created, when an owner appears while the person is typing', async () => {
    const email = newOwner().email;
    const raceEmail = `race-${randomUUID().slice(0, 8)}@example.com`;
    const { prompter } = scripted([
      '',
      email,
      'Layla Haddad',
      CHOSEN_PASSWORD,
      // Someone else sets up an owner (here: directly in the database) after the password was typed, before the insert.
      async () => {
        const { db } = await testDb();
        await insertStaff(db, await insertRole(db, ['*'], 'Chief'), { email: raceEmail });
        return CHOSEN_PASSWORD;
      },
    ]);
    const { result, said } = await flow({ prompter });
    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(/An owner account already exists/);
    expect(result.error).toMatch(/Admins & access/);
    expect(said.join('\n')).not.toContain('First admin created');
    const { db } = await testDb();
    expect((await db.select({ email: s.staffUsers.email }).from(s.staffUsers)).map((row) => row.email)).toEqual([
      raceEmail,
    ]);
    expect(await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'added admin'))).toEqual([]);
  });

  it('asks nothing when an owner already exists', async () => {
    await run(newOwner());
    const { prompter, questions } = scripted([]);
    const { result, said } = await flow({ prompter });
    expect(result).toEqual({ exitCode: 0 });
    expect(questions).toEqual([]);
    expect(said.at(-1)).toBe('✓ Admin account: already there');
  });

  it('asks nothing without a prompter and says how to create the first admin', async () => {
    const { result, said } = await flow({});
    expect(result).toEqual({ exitCode: 0 });
    expect(said.at(-1)).toBe(NO_ADMIN_HINT);
    expect((await tableCounts()).staff).toBe(0);
  });

  it('with an owner from the flags makes it in the same transaction and prints the temporary password once', async () => {
    const owner = newOwner();
    const { result, said } = await flow({ owner });
    expect(result).toEqual({ exitCode: 0 });
    const password = /Temporary password \(shown once, copy it now\): (\S+)/.exec(said.join('\n'))?.[1];
    expect(password).toBeDefined();
    expect(said.join('\n').split(password!).length - 1).toBe(1);
    expect(said).toContain(`✓ First admin created: ${owner.email}`);
  });

  it('with an owner from the flags and an owner already there, refuses and changes nothing', async () => {
    await run(newOwner());
    const before = await tableCounts();
    const { result, said } = await flow({ owner: newOwner() });
    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(/Admins & access/);
    expect(said).toEqual([]);
    expect(await tableCounts()).toEqual(before);
  });
});

/** Runs `bun scripts/setup.ts` against the test database, as an operator would run `bun run setup` (no terminal). */
async function setupCommand(args: string[], stdin?: string) {
  const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/setup.ts', ...args], {
    cwd: new URL('../..', import.meta.url).pathname,
    // No env file: the child gets this worktree's own test databases explicitly (never a default that points at the developer's).
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '/tmp',
      ...testInstanceEnv(),
      NODE_ENV: 'test',
      DATABASE_URL_TEST: TEST_DATABASE_URL,
    },
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

/** Starts `bun scripts/setup.ts` in a pseudo-terminal, so it sees a person at the keyboard. */
function setupInTerminal(...args: string[]) {
  return runInTerminal([process.execPath, '--no-env-file', 'scripts/setup.ts', ...args], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '/tmp',
      TERM: 'xterm-256color',
      ...testInstanceEnv(),
      NODE_ENV: 'test',
      DATABASE_URL_TEST: TEST_DATABASE_URL,
    },
  });
}

describe('bun run setup', () => {
  it('prints the temporary password once, and it signs in through the real routes as an owner', async () => {
    const owner = newOwner();
    const result = await setupCommand(['--email', owner.email, '--name', owner.name]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('✓ Migrations: up to date');
    expect(result.stdout).toContain(`✓ First admin created: ${owner.email}`);
    const password = /Temporary password \(shown once, copy it now\): (\S+)/.exec(result.stdout)?.[1];
    expect(password).toBeDefined();
    // Printed once, nowhere else.
    expect(result.stdout.split(password!).length - 1).toBe(1);

    // The same flow as a member made with POST /admin/staff in its temporary_password mode.
    clock.reset();
    const ip = freshClientIp();
    const first = new StaffConsole(t, ip);
    expect((await first.login(owner.email, password)).json()).toEqual({ next: 'password' });
    const NEW_PASSWORD = 'a-brand-new-passphrase';
    expect((await first.setPassword({ password: NEW_PASSWORD })).statusCode).toBe(204);

    // Then the 2FA enrollment every new member goes through (decision 018: two factors are mandatory).
    const console = new StaffConsole(t, ip);
    expect((await console.login(owner.email, NEW_PASSWORD)).json()).toEqual({ next: 'totp_setup' });
    const { secret } = (await console.setup()).json<{ secret: string }>();
    expect((await console.code(await codeFor(secret, clock.nowMs()))).statusCode).toBe(204);

    const me = (await console.me()).json<Record<string, unknown>>();
    expect(me).toMatchObject({
      email: owner.email,
      name: owner.name,
      status: 'active',
      role: { name: 'Owner' },
      permissions: ['*'],
      twofaEnabled: true,
      mustChangePassword: false,
    });

    // An Owner can do everything: add a staff member (the first of the console's "Admins & access").
    const added = await console.call('POST', '/admin/staff', {
      name: 'Nadia Hamdan',
      email: `nadia-${randomUUID().slice(0, 8)}@example.com`,
      roleId: (me.role as { id: number }).id,
      onboarding: 'temporary_password',
    });
    expect(added.statusCode).toBe(201);
    expect(added.json<{ createdBy: { id: number; name: string } }>().createdBy).toEqual({
      id: me.id as number,
      name: owner.name,
    });
  });

  it('with --password-stdin reads the chosen password, prints none, and the owner signs in straight to the TOTP setup', async () => {
    const owner = newOwner();
    const result = await setupCommand(
      ['--email', owner.email, '--name', owner.name, '--password-stdin'],
      `${CHOSEN_PASSWORD}\n`,
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`✓ First admin created: ${owner.email}`);
    expect(result.stdout).toContain('you will set up 2FA (TOTP) first');
    expect(result.stdout).not.toContain('Temporary password');
    expect(result.stdout).not.toContain(CHOSEN_PASSWORD);

    const { db } = await testDb();
    const [row] = await db.select().from(s.staffUsers);
    expect(row).toMatchObject({ status: 'invited', mustChangePassword: false });
    const audit = JSON.stringify(await db.select().from(s.auditLogs));
    expect(audit).toContain('chosen_password');
    expect(audit).not.toContain(CHOSEN_PASSWORD);
    expect(audit).not.toContain(row!.passwordHash);
    await signInAndEnroll(owner.email, CHOSEN_PASSWORD);
  });

  it('with --password-stdin refuses a weak password or an empty input with exit code 1, creates nothing and never repeats the password', async () => {
    const owner = newOwner();
    const args = ['--email', owner.email, '--name', owner.name, '--password-stdin'];
    const weak = await setupCommand(args, 'short-pw\n');
    expect(weak.code).toBe(1);
    expect(weak.stderr).toContain('--password-stdin: Use at least 10 characters.');
    expect(weak.stdout + weak.stderr).not.toContain('short-pw');
    const holdsName = await setupCommand(args, 'haddad-and-more-9\n');
    expect(holdsName.code).toBe(1);
    expect(holdsName.stderr).toContain('Do not use your name in your password.');
    const empty = await setupCommand(args, '\n');
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain('no password was given');
    const twoLines = await setupCommand(args, `${CHOSEN_PASSWORD}\nsecond\n`);
    expect(twoLines.code).toBe(1);
    expect(twoLines.stderr).toContain('one line');
    expect(await tableCounts()).toEqual({ currencies: 0, accounts: 0, roles: 0, staff: 0, audit: 0 });
  }, 60_000);

  it('asks nothing without a terminal and without flags: it prints the reference data and how to create the first admin', async () => {
    const result = await setupCommand([]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('✓ Migrations: up to date');
    expect(result.stdout).toContain('✓ Base currency USD: created');
    expect(result.stdout).toContain('✓ 12 system ledger accounts: created');
    expect(result.stdout).toContain('✓ Owner role: created');
    expect(result.stdout).toContain(NO_ADMIN_HINT);
    expect(result.stdout).not.toContain('Create the first one now?');
    expect(await tableCounts()).toMatchObject({ currencies: 1, accounts: 12, roles: 1, staff: 0 });
  }, 60_000);

  it('says what already existed on a second run, and refuses a second owner with exit code 1', async () => {
    const owner = newOwner();
    expect((await setupCommand(['--email', owner.email, '--name', owner.name])).code).toBe(0);
    const again = await setupCommand([]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('✓ Base currency USD: already there');
    expect(again.stdout).toContain('✓ 12 system ledger accounts: already there');
    expect(again.stdout).toContain('✓ Owner role: already there');
    expect(again.stdout).toContain('✓ Admin account: already there');
    expect(again.stdout).not.toContain('Temporary password');

    const second = await setupCommand(['--email', newOwner().email, '--name', 'Someone Else']);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('Admins & access');
    expect(second.stdout).not.toContain('Temporary password');
    expect((await tableCounts()).staff).toBe(1);
  }, 60_000);

  it('refuses bad arguments with a clear message and exit code 1, before touching the database', async () => {
    // Every message is unit-tested (test/unit/first-run-args.test.ts); here two commands prove that a bad value and a bad combination
    // stop the command before the configuration is read. Kept to two on purpose: eight spawns in a row inside the 12-file batch of
    // `bun run test` pushed the batch's memory from 3.0 GB to 4.3 GB (measured); the guard's default is now 6000 MB (test/setup.ts)
    // and the batch peaks near 3 GB, so keep the spawns few.
    const cases: Array<[string[], RegExp]> = [
      [['--email', 'not-an-email', '--name', 'Layla Haddad'], /--email: Enter a valid email address\./],
      [['--email', 'layla@example.com', '--password-stdin'], /--password-stdin needs both --email and --name/],
    ];
    for (const [args, message] of cases) {
      const result = await setupCommand(args);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(message);
      // Nothing at all was printed on stdout: not a migration line, not a reference-data line.
      expect(result.stdout).toBe('');
    }
    expect(await tableCounts()).toEqual({ currencies: 0, accounts: 0, roles: 0, staff: 0, audit: 0 });
  }, 60_000);

  it('answers --help with the usage and exit code 0', async () => {
    const result = await setupCommand(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: bun run setup');
    expect(result.stdout).toContain('--password-stdin');
  });
});

describe('bun run setup in a terminal', () => {
  it('asks the questions of the approved transcript, shows only * for the password, and creates the admin', async () => {
    const email = newOwner().email;
    const session = setupInTerminal();
    await session.waitFor('✓ Owner role: created');
    await session.waitFor('Create the first one now? [Y/n] ');
    session.send('\r');
    await session.waitFor('Email: ');
    session.send(`${email}\r`);
    await session.waitFor('Full name: ');
    session.send('Layla Haddad\r');
    await session.waitFor('Password: ');
    // Three extra characters typed by mistake, then taken back with backspace.
    session.send(`${CHOSEN_PASSWORD}XYZ\x7f\x7f\x7f\r`);
    await session.waitFor('Repeat password: ');
    session.send(`${CHOSEN_PASSWORD}\r`);
    await session.waitFor('you will set up 2FA (TOTP) first.');
    expect(await session.exitCode()).toBe(0);

    const screen = session.screen();
    expect(screen).toContain('✓ Migrations: up to date');
    expect(screen).toContain(`✓ First admin created: ${email}`);
    // The password is never shown, only one * per character.
    expect(screen).not.toContain(CHOSEN_PASSWORD);
    expect(screen).not.toContain('XYZ');
    expect(screen).toContain('Repeat password: ' + '*'.repeat(CHOSEN_PASSWORD.length));
    await signInAndEnroll(email, CHOSEN_PASSWORD);
  }, 60_000);

  it('asks a bad answer again, and answering n ends without an admin (exit code 0)', async () => {
    const answers = setupInTerminal();
    await answers.waitFor('Create the first one now? [Y/n] ');
    answers.send('maybe\r');
    await answers.waitFor('Answer y or n.');
    await answers.waitFor('Create the first one now? [Y/n] ');
    answers.send('n\r');
    await answers.waitFor('Run `bun run setup` again');
    expect(await answers.exitCode()).toBe(0);
    expect((await tableCounts()).staff).toBe(0);
  }, 60_000);

  it('turns Ctrl+C at a plain question, and at the hidden password question, into exit code 130 with no admin', async () => {
    const atEmail = setupInTerminal();
    await atEmail.waitFor('Create the first one now? [Y/n] ');
    atEmail.send('\r');
    await atEmail.waitFor('Email: ');
    atEmail.send('\x03');
    await atEmail.waitFor('Cancelled: no admin account was created.');
    expect(await atEmail.exitCode()).toBe(130);

    const atPassword = setupInTerminal();
    await atPassword.waitFor('Create the first one now? [Y/n] ');
    atPassword.send('\r');
    await atPassword.waitFor('Email: ');
    atPassword.send(`${newOwner().email}\r`);
    await atPassword.waitFor('Full name: ');
    atPassword.send('Layla Haddad\r');
    await atPassword.waitFor('Password: ');
    atPassword.send('half-typed');
    atPassword.send('\x03');
    await atPassword.waitFor('Cancelled: no admin account was created.');
    expect(await atPassword.exitCode()).toBe(130);
    expect((await tableCounts()).staff).toBe(0);
  }, 60_000);

  it('refuses --password-stdin when standard input is the keyboard, asks nothing and creates nothing', async () => {
    const owner = newOwner();
    const session = setupInTerminal('--email', owner.email, '--name', owner.name, '--password-stdin');
    // Read the screen first: `exitCode()` closes the terminal at once, so a late chunk would be lost.
    await session.waitFor('reads the password from a pipe, not from the keyboard');
    expect(await session.exitCode()).toBe(1);
    expect(session.screen()).not.toContain('Password:');
    expect(session.screen()).not.toContain('✓');
    expect(await tableCounts()).toEqual({ currencies: 0, accounts: 0, roles: 0, staff: 0, audit: 0 });
  }, 60_000);

  it('does not ask when --email and --name are given, even in a terminal', async () => {
    const owner = newOwner();
    const session = setupInTerminal('--email', owner.email, '--name', owner.name);
    await session.waitFor('Temporary password (shown once, copy it now): ');
    expect(await session.exitCode()).toBe(0);
    expect(session.screen()).not.toContain('Create the first one now?');
    expect((await tableCounts()).staff).toBe(1);
  }, 60_000);
});

describe.skipIf(!existsSync(demoStatePath()))('the demo seed and the first run', () => {
  it('create the same base currency and the same 12 system accounts (they share one definition)', async () => {
    // The seed replays about 2,000 journals and allocates gigabytes of short-lived objects. Inside a batch of a dozen files the test
    // process is already large, and the collector then lets the heap grow to 4.4 GB (measured; the memory guard's default is 6000 MB,
    // test/setup.ts), so the seed runs in a process of its own and hands over the rows it made.
    const child = Bun.spawn([process.execPath, '--no-env-file', 'test/support/seed-reference.ts'], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '/tmp',
        NODE_ENV: 'test',
        DATABASE_URL_TEST: TEST_DATABASE_URL,
        ...(process.env.FRONTEND_DIR ? { FRONTEND_DIR: process.env.FRONTEND_DIR } : {}),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr.replace(/^\s*money .*credit limit.*$/gm, '').trim()).toBe('');
    expect(code).toBe(0);
    const seeded = JSON.parse(stdout.trim().split('\n').at(-1)!) as Awaited<ReturnType<typeof referenceRows>>;

    await resetDb();
    await run();
    const { db } = await testDb();
    // JSON turns dates into text; the compared rows hold none (the dates are left out), so the shapes are equal.
    expect(JSON.parse(JSON.stringify(await referenceRows(db)))).toEqual(seeded);
    expect(seeded.accounts).toHaveLength(12);
  }, 120_000);
});
