// The search for the password of a sign-up and of its finish (decision 079, the review's S6): the app's logger runs at trace level into a
// buffer while the two routes answer a success, a 422, a 429 and a forced 500; then the buffer, the answers, audit_logs, outbox_events,
// notifications and the mails are searched for the password text. Its own file: the level of the root logger is the process's.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { asc, inArray } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { LightMyRequestResponse } from 'fastify';
import { PasswordHasher } from '@src/infra/crypto';
import { schema as s } from '@src/infra/db';
import { AccountMailJobs } from '@src/modules/identity/application/mail/account-mail-jobs';
import { ensureRetailGroup } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { insertStoreCurrencies, insertTaxRates } from '../../support/customers';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { logSink } from '../../support/log-sink';
import { mailbox, sendAllQueued } from '../../support/notifications';
import { freshClientIp } from '../../support/pipeline-routes';
import {
  SIGN_UP_PASSWORD,
  STORE_ORIGIN,
  StoreClient,
  captureCustomerLinks,
  clearStoreRateLimits,
  customerLinks,
} from '../../support/store';

const clock = new TestClock('2026-11-28T09:00:00.000Z');
let t: TestApp;
let levelBefore: string | undefined;

/** A password the policy refuses (it holds the first name), sent with a 422. */
const WEAK_SECRET = 'Daniel-Quartz-Lantern-91';
/** The password of the finish. */
const FINISH_SECRET = 'Finish-Tide-Orchard-58';

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: STORE_ORIGIN, LOG_LEVEL: 'trace' }, clock });
  // One root logger per process: the first app of the process chose its level. This file needs every line.
  levelBefore = PinoLogger.root.level;
  PinoLogger.root.level = 'trace';
}, 60_000);
afterAll(async () => {
  if (levelBefore !== undefined) PinoLogger.root.level = levelBefore;
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  const { db } = await testDb();
  await ensureRetailGroup(db);
  await insertTaxRates(db, ['GB', 'JO']);
  await insertStoreCurrencies(db);
  captureCustomerLinks(t);
  mailbox(t).reset();
  logSink.clear();
});
afterEach(() => mock.restore());

/** Runs the account link mails the way the worker would. */
async function sendLinkMails(): Promise<void> {
  const { db } = await testDb();
  const jobs = t.app.get(AccountMailJobs);
  const events = await db
    .select()
    .from(s.outboxEvents)
    .where(inArray(s.outboxEvents.type, ['customer.magic_link', 'customer.sign_up_link', 'customer.sign_up_existing']))
    .orderBy(asc(s.outboxEvents.id));
  for (const event of events) {
    const { meta: _meta, ...payload } = event.payload;
    await jobs.handle(event.type, {
      data: {
        eventId: event.id,
        type: event.type,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload,
        requestId: 'test',
      },
    } as never);
  }
}

describe('no password anywhere (decision 079, S6)', () => {
  it('keeps the passwords of a sign-up and of its finish out of the trace log, the answers, the audit log, the outbox and the mails', async () => {
    // The buffer takes trace lines.
    PinoLogger.root.trace('trace probe');
    expect(logSink.lines.some((line) => line.level === 10 && line.msg === 'trace probe')).toBe(true);
    const answers: LightMyRequestResponse[] = [];
    const keep = (res: LightMyRequestResponse) => {
      answers.push(res);
      return res;
    };
    const hasher = t.app.get(PasswordHasher);

    // The sign-up: 204, 422 (a field, and the policy), a forced 500, and 429.
    const sender = new StoreClient(t, freshClientIp());
    expect(keep(await sender.signUp({ email: 'secret@example.com' })).statusCode).toBe(204);
    expect(
      keep(await new StoreClient(t, freshClientIp()).signUp({ email: 'secret@example.com', phone: '12' })).statusCode,
    ).toBe(422);
    const weak = keep(
      await new StoreClient(t, freshClientIp()).signUp({ email: 'secret@example.com', password: WEAK_SECRET }),
    );
    expect([weak.statusCode, weak.json<{ code: string }>().code]).toEqual([422, 'WEAK_PASSWORD']);
    const failing = spyOn(hasher, 'hash').mockRejectedValue(new Error('the hasher is down'));
    expect(keep(await new StoreClient(t, freshClientIp()).signUp({ email: 'secret@example.com' })).statusCode).toBe(
      500,
    );
    failing.mockRestore();
    const ip = freshClientIp();
    const limited: number[] = [];
    for (let i = 0; i < 6; i++)
      limited.push(keep(await new StoreClient(t, ip).signUp({ email: 'limited@example.com' })).statusCode);
    expect(limited).toEqual([204, 204, 204, 204, 204, 429]);

    // The finish, after the link was opened in another browser: 422, a forced 500, 200, then 409 and 429.
    const elsewhere = new StoreClient(t, freshClientIp());
    const link = customerLinks().find((candidate) => candidate.accountId === customerLinks()[0]!.accountId)!;
    expect(keep(await elsewhere.verify(link.token)).json()).toMatchObject({ passwordSet: false });
    expect(keep(await elsewhere.finishSignUp({ password: FINISH_SECRET, country: 'FR' })).statusCode).toBe(422);
    const failingFinish = spyOn(hasher, 'hash').mockRejectedValue(new Error('the hasher is down'));
    expect(keep(await elsewhere.finishSignUp({ password: FINISH_SECRET })).statusCode).toBe(500);
    failingFinish.mockRestore();
    expect(keep(await elsewhere.finishSignUp({ password: FINISH_SECRET })).statusCode).toBe(200);
    const after: number[] = [];
    for (let i = 0; i < 3; i++) after.push(keep(await elsewhere.finishSignUp({ password: FINISH_SECRET })).statusCode);
    expect(after).toEqual([409, 409, 429]);
    expect((await new StoreClient(t, freshClientIp()).login('secret@example.com', FINISH_SECRET)).statusCode).toBe(200);

    // The mails go out.
    await sendLinkMails();
    await sendAllQueued(t);
    expect(mailbox(t).sent.length).toBeGreaterThan(0);

    // The forced failures were logged (at error), and the buffer holds lines of every level the app wrote.
    expect(logSink.lines.some((line) => line.level >= 50)).toBe(true);
    const { db } = await testDb();
    const places: Record<string, unknown> = {
      log: logSink.lines,
      answers: answers.map((res) => ({ headers: res.headers, body: res.body })),
      audit: await db.select().from(s.auditLogs),
      outbox: await db.select().from(s.outboxEvents),
      notifications: await db.select().from(s.notifications),
      waiting: await db.select().from(s.accountSignups),
      mails: mailbox(t).sent,
    };
    for (const [place, rows] of Object.entries(places)) {
      const text = JSON.stringify(rows);
      for (const secret of [SIGN_UP_PASSWORD, WEAK_SECRET, FINISH_SECRET])
        expect(text, `${place}: ${secret}`).not.toContain(secret);
    }
  });
});
