// Integration tests of the daily cap on wrong authenticator codes (POST /admin/auth/2fa and POST /client/auth/2fa) through HTTP on the
// real application: twenty wrong codes of one person (a staff member, or an account of either rank) within 24 hours close the code step,
// also to the right code, until those 24 hours end (it then opens by itself with a count of zero), a new password is set by an emailed
// link or by staff, or staff reset two-factor sign-in; a correct code never resets the count; the closing is audited once; every wrong
// code is logged.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { TokenService } from '@src/infra/crypto';
import { DbService, schema as s } from '@src/infra/db';
import { StaffAuthTokens } from '@src/modules/identity';
import { CodeStepLock } from '@src/modules/identity/application/code-step-lock';
import { CLIENT_TOTP_AAD, TotpService } from '@src/modules/identity/application/totp.service';
import { MAX_FAILED_CODES } from '@src/modules/identity/domain/code-step-lock';
import { makeAccount } from '../../support/accounts';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, clearRateLimits } from '../../support/auth';
import { DAY, HOUR, MINUTE, SECOND, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { logSink } from '../../support/log-sink';
import {
  MERCHANT_PASSWORD,
  MerchantPortal,
  PORTAL_ORIGIN,
  makeMerchant,
  seedPortalBasics,
} from '../../support/merchant-portal';
import { freshClientIp } from '../../support/pipeline-routes';
import { CONSOLE_ORIGIN, StaffConsole, codeFor, makeStaff } from '../../support/staff-console';

/** The app's clock: authenticator codes, session lifetimes and the 24-hour count follow it (decision 031). */
const clock = new TestClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CONSOLE_ORIGINS: CONSOLE_ORIGIN, SHOP_ORIGINS: PORTAL_ORIGIN }, clock });
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
  await clearRateLimits(t);
  logSink.clear();
  await seedPortalBasics();
});

const NEW_PASSWORD = 'a-brand-new-passphrase';
const LOCK_ACTION = 'locked the authenticator step of';

/** The code an authenticator app shows `steps` time steps (30 s) from the app's now. */
const codeNow = (secret: string, steps = 0): Promise<string> => codeFor(secret, clock.nowMs() + steps * 30 * SECOND);

/** A six-digit code that is none of the three codes the server accepts now (steps -1, 0, +1). */
async function wrongCode(secret: string): Promise<string> {
  const valid = new Set(await Promise.all([-1, 0, 1].map((k) => codeNow(secret, k))));
  for (let n = 0; ; n += 1) {
    const guess = String(123456 + n).padStart(6, '0');
    if (!valid.has(guess)) return guess;
  }
}

const problem = (res: { json: () => unknown }) => res.json() as { code: string };
const lockRows = async () =>
  (await (await testDb()).db.select().from(s.auditLogs).orderBy(asc(s.auditLogs.id))).filter(
    (row) => row.action === LOCK_ACTION,
  );

/**
 * Stores a count of wrong codes on an account, as if they had been sent (the 15-minute budget would make a test wait an hour); `closed`
 * also records the closing, as the wrong code that reached the cap does.
 */
async function setCount(
  type: 'staff' | 'account',
  id: number,
  failures: number,
  sinceMs: number,
  closed = false,
): Promise<void> {
  const { db } = await testDb();
  const values = {
    totpFailures: failures,
    totpFailuresSince: new Date(sinceMs),
    totpLockedAt: closed ? new Date(clock.nowMs()) : null,
  };
  if (type === 'staff') await db.update(s.staffUsers).set(values).where(eq(s.staffUsers.id, id));
  else await db.update(s.clients).set(values).where(eq(s.clients.id, id));
}

/** The count of wrong codes on an account's row. */
async function countOf(
  type: 'staff' | 'account',
  id: number,
): Promise<{ totpFailures: number; totpFailuresSince: Date | null; totpLockedAt: Date | null }> {
  const { db } = await testDb();
  const [row] =
    type === 'staff'
      ? await db.select().from(s.staffUsers).where(eq(s.staffUsers.id, id))
      : await db.select().from(s.clients).where(eq(s.clients.id, id));
  return {
    totpFailures: row!.totpFailures,
    totpFailuresSince: row!.totpFailuresSince,
    totpLockedAt: row!.totpLockedAt,
  };
}

/** The warnings the code step wrote for the wrong codes of one account. */
const wrongCodeWarnings = (type: 'staff' | 'account', id: number) =>
  logSink.lines.filter(
    (line) => line.level === 40 && String(line.msg ?? '').startsWith(`Wrong authenticator code (${type} ${id})`),
  );

/** Ends the 15-minute code budget, as if a quarter of an hour had passed (its counter lives in the cache Redis). */
async function nextQuarterHour(): Promise<void> {
  await clearRateLimits(t);
  clock.advance(16 * MINUTE);
}

describe('the code step of a staff member', () => {
  it('twenty wrong codes within a day close it, also to the right code, until a password link sets a new password', async () => {
    const member = await makeStaff(t, { permissions: ['*'] });
    const guesserIp = freshClientIp();
    const guesser = new StaffConsole(t, guesserIp);
    const own = freshClientIp();
    const sent = new Set<string>();

    // Four wrong codes a quarter of an hour, under the 15-minute budget, for five quarters: twenty in 80 minutes.
    for (let round = 0; round < 5; round += 1) {
      expect((await guesser.login(member.email)).statusCode).toBe(200);
      for (let n = 0; n < 4; n += 1) {
        const wrong = await wrongCode(member.secret);
        sent.add(wrong);
        expect((await guesser.code(wrong)).statusCode).toBe(422);
      }
      if (round === 1) {
        // The member signs in from their own network meanwhile: a correct code does not reset the count.
        const real = new StaffConsole(t, own);
        expect((await real.login(member.email)).statusCode).toBe(200);
        expect((await real.code(await codeNow(member.secret))).statusCode).toBe(204);
      }
      await nextQuarterHour();
    }

    // Every wrong code left one warning that names the account and the address, and none holds the code.
    const warnings = wrongCodeWarnings('staff', member.id);
    expect(warnings).toHaveLength(20);
    for (const line of warnings) expect(String(line.msg)).toContain(guesserIp);
    for (const code of sent) expect(JSON.stringify(warnings)).not.toContain(code);

    // The right code is refused now, whoever sends it, with the real wait: 24 hours from the first wrong code, 80 minutes ago.
    expect((await guesser.login(member.email)).statusCode).toBe(200);
    const refused = await guesser.code(await codeNow(member.secret));
    expect(refused.statusCode).toBe(429);
    expect(problem(refused).code).toBe('RATE_LIMITED');
    expect(refused.headers['retry-after']).toBe(String(24 * 3600 - 80 * 60));
    expect(refused.json<{ detail: string }>().detail).toContain('opens again in 22 hours 40 minutes');
    const real = new StaffConsole(t, own);
    expect((await real.login(member.email)).statusCode).toBe(200);
    expect((await real.code(await codeNow(member.secret))).statusCode).toBe(429);
    expect(await lockRows()).toMatchObject([{ entityType: 'staff', entityId: member.id }]);

    // A new password from an emailed link opens it again at once.
    const { token } = await t.app
      .get(DbService)
      .runInTransaction((work) => t.app.get(StaffAuthTokens).issue(work, { staffId: member.id, purpose: 'reset' }));
    expect((await new StaffConsole(t).setPassword({ token, password: NEW_PASSWORD }, { csrf: false })).statusCode).toBe(
      204,
    );
    const after = new StaffConsole(t, own);
    expect((await after.login(member.email, NEW_PASSWORD)).statusCode).toBe(200);
    expect((await after.code(await codeNow(member.secret))).statusCode).toBe(204);
    expect(await lockRows()).toHaveLength(1);
  });

  it('opens again by itself when the 24 hours from the first wrong code end, with a count of zero', async () => {
    const member = await makeStaff(t, { permissions: ['*'] });
    const firstWrongMs = clock.nowMs() - HOUR;
    await setCount('staff', member.id, 19, firstWrongMs);
    const c = new StaffConsole(t, freshClientIp());
    expect((await c.login(member.email)).statusCode).toBe(200);
    expect((await c.code(await wrongCode(member.secret))).statusCode).toBe(422);
    const closed = await c.code(await codeNow(member.secret));
    expect(closed.statusCode).toBe(429);
    expect(closed.headers['retry-after']).toBe(String(23 * 3600));
    expect(await lockRows()).toHaveLength(1);

    // One second before the 24 hours end it is still closed, and says so.
    clock.set(firstWrongMs + DAY - SECOND);
    await clearRateLimits(t);
    const d = new StaffConsole(t, freshClientIp());
    expect((await d.login(member.email)).statusCode).toBe(200);
    const last = await d.code(await codeNow(member.secret));
    expect(last.statusCode).toBe(429);
    expect(last.headers['retry-after']).toBe('1');

    // At the end of the 24 hours the right code works, and nothing stays counted.
    clock.advance(SECOND);
    const e = new StaffConsole(t, freshClientIp());
    expect((await e.login(member.email)).statusCode).toBe(200);
    expect((await e.code(await codeNow(member.secret))).statusCode).toBe(204);
    expect(await countOf('staff', member.id)).toEqual({ totpFailures: 0, totpFailuresSince: null, totpLockedAt: null });

    // The next wrong code starts new 24 hours at one.
    clock.advance(MINUTE);
    const f = new StaffConsole(t, freshClientIp());
    expect((await f.login(member.email)).statusCode).toBe(200);
    expect((await f.code(await wrongCode(member.secret))).statusCode).toBe(422);
    expect(await countOf('staff', member.id)).toEqual({
      totpFailures: 1,
      totpFailuresSince: new Date(clock.nowMs()),
      totpLockedAt: null,
    });
    expect(await lockRows()).toHaveLength(1);
  });

  it('a correct code inside the 24 hours keeps the count and its start', async () => {
    const member = await makeStaff(t);
    const firstWrongMs = clock.nowMs() - 2 * HOUR;
    await setCount('staff', member.id, 19, firstWrongMs);
    const c = new StaffConsole(t, freshClientIp());
    expect((await c.login(member.email)).statusCode).toBe(200);
    expect((await c.code(await codeNow(member.secret))).statusCode).toBe(204);
    expect(await countOf('staff', member.id)).toEqual({
      totpFailures: 19,
      totpFailuresSince: new Date(firstWrongMs),
      totpLockedAt: null,
    });

    clock.advance(MINUTE);
    const d = new StaffConsole(t, freshClientIp());
    expect((await d.login(member.email)).statusCode).toBe(200);
    expect((await d.code(await wrongCode(member.secret))).statusCode).toBe(422);
    expect((await d.code(await codeNow(member.secret))).statusCode).toBe(429);
    expect(await lockRows()).toHaveLength(1);
  });

  it('counts over 24 hours from the first wrong code: an older count starts again, a younger one reaches the cap', async () => {
    const { db } = await testDb();
    const member = await makeStaff(t);
    const c = new StaffConsole(t, freshClientIp());

    // Nineteen wrong codes that began more than 24 hours ago: the next wrong code starts a new count.
    await setCount('staff', member.id, 19, clock.nowMs() - 24 * HOUR - MINUTE);
    expect((await c.login(member.email)).statusCode).toBe(200);
    expect((await c.code(await wrongCode(member.secret))).statusCode).toBe(422);
    expect((await c.code(await codeNow(member.secret))).statusCode).toBe(204);
    const [fresh] = await db.select().from(s.staffUsers).where(eq(s.staffUsers.id, member.id));
    expect(fresh).toMatchObject({ totpFailures: 1, totpFailuresSince: new Date(clock.nowMs()) });
    expect(await lockRows()).toHaveLength(0);

    // Nineteen that began 23 hours ago: the next wrong code is the twentieth and closes the step.
    clock.advance(MINUTE);
    await setCount('staff', member.id, 19, clock.nowMs() - 23 * HOUR);
    const d = new StaffConsole(t, freshClientIp());
    expect((await d.login(member.email)).statusCode).toBe(200);
    expect((await d.code(await wrongCode(member.secret))).statusCode).toBe(422);
    expect((await d.code(await codeNow(member.secret))).statusCode).toBe(429);
    expect(await lockRows()).toHaveLength(1);
  });

  it('checks one of the codes sent at the same moment as the twentieth and refuses the others before checking them', async () => {
    const { db } = await testDb();
    const member = await makeStaff(t);
    await setCount('staff', member.id, 19, clock.nowMs());
    const consoles = [0, 1, 2, 3].map(() => new StaffConsole(t, freshClientIp()));
    for (const c of consoles) expect((await c.login(member.email)).statusCode).toBe(200);
    const wrong = await wrongCode(member.secret);
    const answers = await Promise.all(consoles.map((c) => c.code(wrong)));
    expect(answers.map((res) => res.statusCode).sort()).toEqual([422, 429, 429, 429]);
    expect(await lockRows()).toHaveLength(1);
    const [row] = await db.select().from(s.staffUsers).where(eq(s.staffUsers.id, member.id));
    expect(row!.totpFailures).toBe(20);
  });

  it('records one closing when the right code is checked at the same moment as the wrong codes that reach the cap', async () => {
    const member = await makeStaff(t);
    for (let run = 0; run < 6; run += 1) {
      // A new time step for the right code of each run (a step is accepted once), and a fresh count of eighteen.
      clock.advance(MINUTE);
      await clearRateLimits(t);
      await setCount('staff', member.id, 18, clock.nowMs());
      const rowsBefore = (await lockRows()).length;
      const consoles = [0, 1, 2, 3].map(() => new StaffConsole(t, freshClientIp()));
      for (const c of consoles) expect((await c.login(member.email)).statusCode).toBe(200);
      const [right, wrong] = [await codeNow(member.secret), await wrongCode(member.secret)];
      const answers = await Promise.all(consoles.map((c, n) => c.code(n === 0 ? right : wrong)));
      const checkedWrong = answers.slice(1).filter((res) => res.statusCode === 422).length;

      // Never more than twenty wrong codes are checked, and the closing is written at most once.
      expect(checkedWrong).toBeLessThanOrEqual(2);
      const written = (await lockRows()).length - rowsBefore;
      expect(written).toBeLessThanOrEqual(1);
      const row = await countOf('staff', member.id);
      expect(row.totpLockedAt !== null).toBe(written === 1);
      if (written === 1) {
        // A recorded closing holds, also once the right code has given its count back.
        const next = new StaffConsole(t, freshClientIp());
        expect((await next.login(member.email)).statusCode).toBe(200);
        expect((await next.code(await codeNow(member.secret, 1))).statusCode).toBe(429);
      } else {
        expect(row.totpFailures).toBeLessThanOrEqual(19);
      }
    }
  });

  it('records the closing once when a correct code gives its count back after the wrong code that reached the cap', async () => {
    const lock = t.app.get(CodeStepLock);
    const meta = { ip: freshClientIp() };
    const member = await makeStaff(t);
    const account = { type: 'staff', id: member.id } as const;

    // The closing is recorded while the correct code is still counted: it holds after the count is given back.
    await setCount('staff', member.id, 18, clock.nowMs());
    await lock.charge(account, meta); // the correct code, counted before it is checked
    await lock.failed(account, await lock.charge(account, meta), member.row.name, meta); // the twentieth attempt, wrong
    await lock.giveBack(account); // the correct code gives its count back
    const refused = await lock.charge(account, meta).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'RATE_LIMITED' });
    expect(await lockRows()).toHaveLength(1);
    expect((await countOf('staff', member.id)).totpFailures).toBe(19);

    // The correct code gives its count back before the wrong one is recorded: that one closes nothing, the next wrong code does, once.
    clock.advance(MINUTE);
    await setCount('staff', member.id, 18, clock.nowMs());
    await lock.charge(account, meta);
    const twentieth = await lock.charge(account, meta);
    await lock.giveBack(account);
    await lock.failed(account, twentieth, member.row.name, meta);
    expect(await lockRows()).toHaveLength(1);
    expect((await countOf('staff', member.id)).totpLockedAt).toBeNull();
    await lock.failed(account, await lock.charge(account, meta), member.row.name, meta);
    expect(await lockRows()).toHaveLength(2);
    expect((await countOf('staff', member.id)).totpLockedAt).toEqual(new Date(clock.nowMs()));
    await lock.failed(account, MAX_FAILED_CODES, member.row.name, meta);
    expect(await lockRows()).toHaveLength(2);
  });

  it('opens again with a temporary password an owner sets, and the code works after the forced change', async () => {
    const member = await makeStaff(t);
    await setCount('staff', member.id, 20, clock.nowMs(), true);
    const c = new StaffConsole(t, freshClientIp());
    expect((await c.login(member.email)).statusCode).toBe(200);
    expect((await c.code(await codeNow(member.secret))).statusCode).toBe(429);

    const owner = await adminWith(t, ['*']);
    const set = await owner.post(`/admin/staff/${member.id}/password`, {
      mode: 'temporary_password',
      revokeSessions: false,
    });
    expect(set.status).toBe(200);
    const after = new StaffConsole(t, freshClientIp());
    expect((await after.login(member.email, set.body.temporaryPassword as string)).json()).toEqual({
      next: 'password',
    });
    expect((await after.setPassword({ password: NEW_PASSWORD })).statusCode).toBe(204);
    expect((await after.login(member.email, NEW_PASSWORD)).json()).toEqual({ next: 'totp' });
    expect((await after.code(await codeNow(member.secret))).statusCode).toBe(204);
  });

  it('opens again with a 2FA reset by another member: the code of the new authenticator works', async () => {
    const member = await makeStaff(t, { permissions: ['*'] });
    await setCount('staff', member.id, 20, clock.nowMs(), true);
    const c = new StaffConsole(t, freshClientIp());
    expect((await c.login(member.email)).statusCode).toBe(200);
    expect((await c.code(await codeNow(member.secret))).statusCode).toBe(429);

    const owner = await adminWith(t, ['*']);
    expect((await owner.post(`/admin/staff/${member.id}/reset-2fa`)).status).toBe(204);
    expect(await countOf('staff', member.id)).toEqual({ totpFailures: 0, totpFailuresSince: null, totpLockedAt: null });

    const after = new StaffConsole(t, freshClientIp());
    expect((await after.login(member.email)).json()).toEqual({ next: 'totp_setup' });
    const setup = await after.setup();
    expect(setup.statusCode).toBe(200);
    const { secret } = setup.json<{ secret: string }>();
    expect((await after.code(await codeNow(secret))).statusCode).toBe(204);
  });
});

describe('the code step of a merchant', () => {
  it('twenty wrong codes within a day close it, also to the right code, until a reset link sets a new password', async () => {
    const merchant = await makeMerchant(t, { twofa: true, emailVerifiedAt: new Date(clock.nowMs()) });
    const guesserIp = freshClientIp();
    const guesser = new MerchantPortal(t, guesserIp);
    const own = freshClientIp();

    for (let round = 0; round < 5; round += 1) {
      expect((await guesser.login(merchant.email)).statusCode).toBe(200);
      for (let n = 0; n < 4; n += 1)
        expect((await guesser.code(await wrongCode(merchant.secret))).statusCode).toBe(422);
      if (round === 1) {
        const real = new MerchantPortal(t, own);
        expect((await real.login(merchant.email)).statusCode).toBe(200);
        expect((await real.code(await codeNow(merchant.secret))).statusCode).toBe(204);
      }
      await nextQuarterHour();
    }
    const warnings = wrongCodeWarnings('account', merchant.id);
    expect(warnings).toHaveLength(20);
    for (const line of warnings) expect(String(line.msg)).toContain(guesserIp);

    expect((await guesser.login(merchant.email)).statusCode).toBe(200);
    const refused = await guesser.code(await codeNow(merchant.secret));
    expect(refused.statusCode).toBe(429);
    expect(problem(refused).code).toBe('RATE_LIMITED');
    expect(refused.headers['retry-after']).toBe(String(24 * 3600 - 80 * 60));
    const real = new MerchantPortal(t, own);
    expect((await real.login(merchant.email)).statusCode).toBe(200);
    expect((await real.code(await codeNow(merchant.secret))).statusCode).toBe(429);
    expect(await lockRows()).toMatchObject([{ entityType: 'account', entityId: merchant.id }]);

    // A new password from a reset link opens it again.
    await (await testDb()).db.insert(s.authTokens).values({
      subjectType: 'account',
      subjectId: merchant.id,
      purpose: 'reset',
      tokenHash: t.app.get(TokenService).hash('code-cap-reset-1'),
      expiresAt: new Date(clock.nowMs() + HOUR),
    });
    expect((await new MerchantPortal(t, freshClientIp()).reset('code-cap-reset-1', NEW_PASSWORD)).statusCode).toBe(204);
    const after = new MerchantPortal(t, own);
    expect((await after.login(merchant.email, NEW_PASSWORD)).json()).toEqual({ next: 'totp' });
    expect((await after.code(await codeNow(merchant.secret))).statusCode).toBe(204);
  });

  it('opens again by itself when the 24 hours from the first wrong code end', async () => {
    const merchant = await makeMerchant(t, { twofa: true, emailVerifiedAt: new Date(clock.nowMs()) });
    const firstWrongMs = clock.nowMs() - HOUR;
    await setCount('account', merchant.id, 19, firstWrongMs);
    const p = new MerchantPortal(t, freshClientIp());
    expect((await p.login(merchant.email)).statusCode).toBe(200);
    expect((await p.code(await wrongCode(merchant.secret))).statusCode).toBe(422);
    const closed = await p.code(await codeNow(merchant.secret));
    expect(closed.statusCode).toBe(429);
    expect(closed.headers['retry-after']).toBe(String(23 * 3600));
    expect(await lockRows()).toMatchObject([{ entityType: 'account', entityId: merchant.id }]);

    clock.set(firstWrongMs + DAY);
    await clearRateLimits(t);
    const q = new MerchantPortal(t, freshClientIp());
    expect((await q.login(merchant.email)).statusCode).toBe(200);
    expect((await q.code(await codeNow(merchant.secret))).statusCode).toBe(204);
    expect(await countOf('account', merchant.id)).toEqual({
      totpFailures: 0,
      totpFailuresSince: null,
      totpLockedAt: null,
    });
  });

  it('opens again with a temporary password staff set, and not with a change the merchant makes itself', async () => {
    const { db } = await testDb();
    const merchant = await makeMerchant(t, { twofa: true, emailVerifiedAt: new Date(clock.nowMs()) });
    const own = new MerchantPortal(t, freshClientIp());
    expect((await own.login(merchant.email)).statusCode).toBe(200);
    expect((await own.code(await codeNow(merchant.secret))).statusCode).toBe(204);

    // Closed while the merchant still holds a full session: its own password change leaves the step closed.
    await setCount('account', merchant.id, 20, clock.nowMs(), true);
    expect((await own.changePassword(MERCHANT_PASSWORD, NEW_PASSWORD)).statusCode).toBe(204);
    const [kept] = await db.select().from(s.clients).where(eq(s.clients.id, merchant.id));
    expect(kept!.totpFailures).toBe(20);
    clock.advance(MINUTE);
    const p = new MerchantPortal(t, freshClientIp());
    expect((await p.login(merchant.email, NEW_PASSWORD)).statusCode).toBe(200);
    expect((await p.code(await codeNow(merchant.secret))).statusCode).toBe(429);

    const staff = await adminWith(t, ['clients:read', 'clients:security']);
    const set = await staff.post(`/admin/clients/${merchant.id}/password`, {
      mode: 'temporary_password',
      revokeSessions: false,
    });
    expect(set.status).toBe(200);
    const after = new MerchantPortal(t, freshClientIp());
    expect((await after.login(merchant.email, set.body.temporaryPassword as string)).json()).toEqual({
      next: 'password',
    });
    expect((await after.changeTemporaryPassword('another-brand-new-passphrase')).json()).toEqual({ next: 'totp' });
    expect((await after.code(await codeNow(merchant.secret))).statusCode).toBe(204);
  });

  it('forgets the count with a 2FA reset by staff', async () => {
    const merchant = await makeMerchant(t, { twofa: true, emailVerifiedAt: new Date(clock.nowMs()) });
    await setCount('account', merchant.id, 20, clock.nowMs(), true);
    const p = new MerchantPortal(t, freshClientIp());
    expect((await p.login(merchant.email)).statusCode).toBe(200);
    expect((await p.code(await codeNow(merchant.secret))).statusCode).toBe(429);

    const staff = await adminWith(t, ['clients:read', 'clients:security']);
    expect((await staff.post(`/admin/clients/${merchant.id}/reset-2fa`)).status).toBe(204);
    expect(await countOf('account', merchant.id)).toEqual({
      totpFailures: 0,
      totpFailuresSince: null,
      totpLockedAt: null,
    });
    expect((await new MerchantPortal(t, freshClientIp()).login(merchant.email)).json()).toEqual({ next: 'done' });
  });
});

describe('the code step of a retail account', () => {
  /** A retail account with two-step sign-in on and a verified email: the secret to type codes from. */
  async function makeRetailWithTwoFactor(): Promise<{ id: number; email: string; secret: string }> {
    const totp = t.app.get(TotpService);
    const secret = totp.newSecret();
    const made = await makeAccount(t, {
      rank: 'retail',
      password: MERCHANT_PASSWORD,
      twofaEnabled: true,
      totpSecretEnc: totp.seal(secret, CLIENT_TOTP_AAD),
      emailVerifiedAt: new Date(clock.nowMs()),
    });
    return { id: made.id, email: made.email, secret };
  }

  it('is closed after twenty wrong codes as for a merchant rank: one count on the account row, one audit row, opened by the clock', async () => {
    const customer = await makeRetailWithTwoFactor();
    const firstWrongMs = clock.nowMs() - HOUR;
    await setCount('account', customer.id, 19, firstWrongMs);
    const p = new MerchantPortal(t, freshClientIp());
    expect((await p.login(customer.email)).json()).toEqual({ next: 'totp' });
    expect((await p.code(await wrongCode(customer.secret))).statusCode).toBe(422);
    expect(wrongCodeWarnings('account', customer.id)).toHaveLength(1);
    const closed = await p.code(await codeNow(customer.secret));
    expect(closed.statusCode).toBe(429);
    expect(problem(closed).code).toBe('RATE_LIMITED');
    expect(closed.headers['retry-after']).toBe(String(23 * 3600));
    expect(await lockRows()).toMatchObject([{ entityType: 'account', entityId: customer.id }]);
    // The twentieth wrong code is counted; the right code that was refused took its own count back.
    expect(await countOf('account', customer.id)).toMatchObject({ totpFailures: 20, totpLockedAt: expect.any(Date) });

    // At the end of the 24 hours the right code works and nothing stays counted.
    clock.set(firstWrongMs + DAY);
    await clearRateLimits(t);
    const q = new MerchantPortal(t, freshClientIp());
    expect((await q.login(customer.email)).json()).toEqual({ next: 'totp' });
    expect((await q.code(await codeNow(customer.secret))).statusCode).toBe(204);
    expect(await countOf('account', customer.id)).toEqual({
      totpFailures: 0,
      totpFailuresSince: null,
      totpLockedAt: null,
    });
  });
});
