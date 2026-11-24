// Integration tests of the merchant email verification (feature 2b and 20, routes POST /client/auth/verify-email and
// /verify-email/resend, MISMATCHES B123) through HTTP on the real application: the link that proves the mailbox, the new link a
// merchant asks for, the outbox event with ids only, and the mail job that follows it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
import { DiscoveryService, ModulesContainer } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import { TokenService } from '@src/infra/crypto';
import { DbService, schema as s } from '@src/infra/db';
import { UnrecoverableError } from '@src/infra/queues';
import { buildProcessorTable, findQueueProcessors } from '@src/infra/queues/queue-processor';
import { ACCOUNT_MAIL_EVENT_TYPES } from '@src/modules/identity/domain/account-mail';
import {
  EmailVerificationMailProcessor,
  MerchantInvitedMailProcessor,
  PasswordResetMailProcessor,
} from '@src/modules/identity/jobs/merchant-mail.processors';
import {
  AccountAuthTokens,
  AccountMailOutbox,
  MERCHANT_MAIL_EVENTS,
  STAFF_MAIL_EVENTS,
  SessionService,
} from '@src/modules/identity';
import { DeliveryError, OutboxRouteRegistry, type OutboxJobData } from '@src/modules/platform';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { HOUR, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { logSink } from '../../support/log-sink';
import {
  MerchantPortal,
  PORTAL_ORIGIN,
  captureEmailedLinks,
  clearPortalRateLimits,
  clientRow,
  emailedLinks,
  makeMerchant,
  seedPortalBasics,
} from '../../support/merchant-portal';
import { clearAccountMailLimits, runMerchantMailJob, seedIdentityTemplates } from '../../support/identity-mail';
import { mailbox, tokenIn } from '../../support/notifications';
import { freshClientIp } from '../../support/pipeline-routes';
import { expectRejection } from '../../support/rejection';

const clock = new TestClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: PORTAL_ORIGIN }, clock });
});
afterEach(() => {
  mock.restore();
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
  await clearPortalRateLimits(t);
  logSink.clear();
  captureEmailedLinks(t);
  await seedPortalBasics();
  await clearAccountMailLimits(t);
  await seedIdentityTemplates((await testDb()).db);
  mailbox(t).reset();
});

const portal = (ip?: string) => new MerchantPortal(t, ip ?? freshClientIp());
const problem = (res: { json: () => unknown }) => res.json() as { code: string; errors?: Array<{ field: string }> };

/**
 * A merchant whose address is not verified asks for a verification link: the merchant, its signed-in portal and the link it was mailed.
 *
 * Why: staff change an address, or the merchant asks again; there is no public sign-up that sends the first link.
 */
async function requested() {
  const merchant = await makeMerchant(t, {
    emailVerifiedAt: null,
    name: 'Ali Hassan',
    email: 'ali.hassan@example.com',
  });
  const session = portal();
  expect((await session.login(merchant.email)).statusCode).toBe(200);
  expect((await session.resendVerification()).statusCode).toBe(204);
  const [link] = emailedLinks();
  return { merchant, session, token: link!.token, clientId: merchant.id };
}

describe('POST /client/auth/verify-email', () => {
  it('marks the email verified once, leaves the status as it was and signs nobody in', async () => {
    const { token, clientId } = await requested();
    clock.advance(10 * 60_000);
    const p = portal();
    const res = await p.verifyEmail(token);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.cookies).toEqual([]);
    expect(await clientRow(clientId)).toMatchObject({ status: 'active' });
    expect((await clientRow(clientId)).emailVerifiedAt?.getTime()).toBe(clock.nowMs());

    const used = await portal().verifyEmail(token);
    expect(used.statusCode).toBe(410);
    expect(problem(used).code).toBe('TOKEN_INVALID');
    const { db } = await testDb();
    expect((await db.select().from(s.authTokens))[0]!.usedAt?.getTime()).toBe(clock.nowMs());
  });

  it('refuses an unknown link, an expired one and a link of another purpose with the same 410', async () => {
    const { token, clientId } = await requested();
    expect(problem(await portal().verifyEmail('A'.repeat(43))).code).toBe('TOKEN_INVALID');
    expect((await portal().verifyEmail('A'.repeat(43))).statusCode).toBe(410);

    // A password link is not an email-verification link.
    const reset = await portal().forgot((await clientRow(clientId)).email);
    expect(reset.statusCode).toBe(204);
    const resetToken = emailedLinks().find((link) => link.kind === 'password_reset')!.token;
    expect((await portal().verifyEmail(resetToken)).statusCode).toBe(410);

    clock.advance(HOUR + 1);
    const late = await portal().verifyEmail(token);
    expect(late.statusCode).toBe(410);
    expect((await clientRow(clientId)).emailVerifiedAt).toBeNull();
  });

  it('answers 422 on token for a missing token and lets only one of two parallel requests use the link', async () => {
    const { token, clientId } = await requested();
    const missing = await portal().call('POST', '/client/auth/verify-email', {});
    expect(missing.statusCode).toBe(422);
    expect(problem(missing).errors?.map((e) => e.field)).toEqual(['token']);

    const results = await Promise.all([portal().verifyEmail(token), portal().verifyEmail(token)]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([204, 410]);
    expect((await clientRow(clientId)).emailVerifiedAt).not.toBeNull();
  });
});

describe('POST /client/auth/verify-email, a suspended merchant (feature 20)', () => {
  it('answers 410 for a link that survived a suspension (the race the voiding of links does not cover)', async () => {
    const { token, clientId } = await requested();
    const { db } = await testDb();
    // A suspension that did not void the link (for example a row changed by hand): the endpoint refuses on its own.
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, clientId));
    const res = await portal().verifyEmail(token);
    expect(res.statusCode).toBe(410);
    expect(problem(res).code).toBe('TOKEN_INVALID');
    expect((await clientRow(clientId)).emailVerifiedAt).toBeNull();
    const rows = await db.select().from(s.authTokens).where(eq(s.authTokens.subjectId, clientId));
    expect(rows.every((row) => row.usedAt === null)).toBe(true);
  });
});

describe('POST /client/auth/verify-email/resend (feature 20)', () => {
  it('sends a new link that replaces the older one (410), and the new one verifies', async () => {
    // The merchant asked once already; it asks again.
    const { merchant, session: p, token: firstToken } = await requested();
    mailbox(t).reset();
    const res = await p.resendVerification();
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.headers['cache-control']).toBe('no-store');

    const { db } = await testDb();
    const open = (await db.select().from(s.authTokens).where(eq(s.authTokens.subjectId, merchant.id))).filter(
      (row) => row.usedAt === null,
    );
    expect(open).toHaveLength(1);
    const events = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'merchant.email_verification'));
    expect(events).toHaveLength(2);
    // Sorted: a jsonb column keeps its keys in its own order, not in the order they were written.
    expect(
      Object.keys(events[1]!.payload)
        .filter((key) => key !== 'meta')
        .sort(),
    ).toEqual(['accountId', 'tokenId']);

    expect((await portal().verifyEmail(firstToken)).statusCode).toBe(410);
    await runMerchantMailJob(t, 'email_verification');
    const delivered = tokenIn(mailbox(t).sent.at(-1)!.text);
    expect((await portal().verifyEmail(delivered)).statusCode).toBe(204);
    expect((await clientRow(merchant.id)).emailVerifiedAt).not.toBeNull();
  });

  it('is 409 CONFLICT when the address is already verified, 401 without a session and 403 CSRF_FAILED without the header', async () => {
    const verified = await makeMerchant(t, { emailVerifiedAt: clock.now() });
    const p = portal();
    await p.login(verified.email);
    const conflict = await p.resendVerification();
    expect(conflict.statusCode).toBe(409);
    expect(problem(conflict).code).toBe('CONFLICT');

    const open = await makeMerchant(t, { emailVerifiedAt: null });
    const q = portal();
    await q.login(open.email);
    const noHeader = await q.resendVerification({ csrf: false });
    expect(noHeader.statusCode).toBe(403);
    expect(problem(noHeader).code).toBe('CSRF_FAILED');
    expect((await portal().resendVerification()).statusCode).toBe(401);
  });

  it('answers 429 on the sixth request in an hour and writes nothing for it; staff and merchant share the counter', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: null });
    const p = portal();
    await p.login(merchant.email);
    for (let i = 0; i < 5; i++) expect((await p.resendVerification()).statusCode).toBe(204);
    const sixth = await p.resendVerification();
    expect(sixth.statusCode).toBe(429);
    expect(problem(sixth).code).toBe('RATE_LIMITED');
    const { db } = await testDb();
    expect(
      await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'merchant.email_verification')),
    ).toHaveLength(5);
  });

  it('is refused for a merchant suspended after the sign-in (403 ACCOUNT_SUSPENDED)', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: null });
    const p = portal();
    await p.login(merchant.email);
    const { db } = await testDb();
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, merchant.id));
    await t.app.get(SessionService).invalidateSubject('account', merchant.id);
    const res = await p.resendVerification();
    expect(res.statusCode).toBe(403);
    expect(problem(res).code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('the merchant mail events', () => {
  it('are registered with the notifications queue, and each has one named processor in the worker table', () => {
    const routes = t.app.get(OutboxRouteRegistry);
    // The seven link mails of both rank kinds are registered by the one account mail outbox (decision 064).
    for (const type of ACCOUNT_MAIL_EVENT_TYPES) {
      expect(routes.get(type), type).toMatchObject({ type, queue: 'notifications' });
    }
    const table = buildProcessorTable(findQueueProcessors(new DiscoveryService(t.app.get(ModulesContainer))));
    const named = [...(table.get('notifications')?.byName.keys() ?? [])].sort();
    // The notifications queue has named processors only: the seven account link mails (three merchant events and four retail events,
    // one processor each), the two jobs of feature 12a, the ticket mail of feature 17, the two staff link mails of feature 20 and the
    // campaign fan-out of feature 23.
    expect(named).toEqual(
      [
        ...ACCOUNT_MAIL_EVENT_TYPES,
        ...Object.values(STAFF_MAIL_EVENTS),
        'notification.campaign_fanout',
        'notification.plan',
        'notification.send',
        'support.ticket_mail',
      ].sort(),
    );
    expect(table.get('notifications')?.catchAll).toBeUndefined();
  });

  async function jobOf(type: string): Promise<{ data: OutboxJobData }> {
    const { db } = await testDb();
    const [event] = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, type));
    const { meta: _meta, ...payload } = event!.payload;
    return {
      data: {
        eventId: event!.id,
        type: event!.type,
        aggregateType: event!.aggregateType,
        aggregateId: event!.aggregateId,
        payload: payload as OutboxJobData['payload'],
        requestId: 'test',
      },
    };
  }

  const processJob = (
    processor: { process(job: never): Promise<unknown> },
    job: { data: OutboxJobData },
    attemptsMade = 0,
  ) => processor.process({ ...job, attemptsMade, opts: { attempts: 5 } } as never);

  it('rotate the link token inside the job, mail the new link and log the mail without the token', async () => {
    await requested();
    const [placeholder] = emailedLinks();
    const { db } = await testDb();
    const [before] = await db.select().from(s.authTokens);
    const log = spyOn(Logger.prototype, 'log');
    const warn = spyOn(Logger.prototype, 'warn');

    const job = await jobOf(MERCHANT_MAIL_EVENTS.email_verification);
    const result = await processJob(t.app.get(EmailVerificationMailProcessor), job);
    expect(result).toEqual({ sent: true });

    // One mail with the merchant's address and a link whose token is NOT the placeholder of the request.
    const [mail] = mailbox(t).sent;
    expect(mailbox(t).sent).toHaveLength(1);
    expect(mail).toMatchObject({ to: 'ali.hassan@example.com', subject: 'Confirm your email address' });
    // Every account's link points at the shop (decision 064); the old merchant page only redirects to it.
    expect(mail!.text).toContain(`${t.config.http.storeBaseUrl}/verify-email?token=`);
    const delivered = tokenIn(mail!.text);
    expect(delivered).not.toBe(placeholder!.token);

    // The row keeps its id and expiry, holds the hash of the delivered token, and the placeholder no longer works.
    const [after] = await db.select().from(s.authTokens);
    expect(after).toMatchObject({ id: before!.id, expiresAt: before!.expiresAt, usedAt: null });
    expect(after!.tokenHash).toBe(t.app.get(TokenService).hash(delivered));
    expect((await portal().verifyEmail(placeholder!.token)).statusCode).toBe(410);

    // The notifications row logs the mail and holds no token and no link anywhere.
    const [row] = await db.select().from(s.notifications);
    expect(row).toMatchObject({
      recipientType: 'account',
      recipientId: placeholder!.clientId,
      channel: 'email',
      event: 'merchant.email_verification',
      status: 'sent',
      attempts: 1,
      dedupeKey: `outbox-${job.data.eventId}:email`,
    });
    expect(JSON.stringify(row)).not.toContain(delivered);
    expect(JSON.stringify(row)).not.toContain('token=');
    const logged = [...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain(delivered);

    // The delivered link works once.
    expect((await portal().verifyEmail(delivered)).statusCode).toBe(204);
  });

  it('run twice without sending twice or spoiling the link that arrived', async () => {
    await requested();
    const job = await jobOf(MERCHANT_MAIL_EVENTS.email_verification);
    const processor = t.app.get(EmailVerificationMailProcessor);
    expect(await processJob(processor, job)).toEqual({ sent: true });
    const delivered = tokenIn(mailbox(t).sent[0]!.text);

    expect(await processJob(processor, job, 1)).toEqual({ sent: false, skipped: 'already_sent' });
    expect(mailbox(t).sent).toHaveLength(1);
    expect((await portal().verifyEmail(delivered)).statusCode).toBe(204);
  });

  it('skip a mail that is no longer worth sending, and fail a job that lost its token id for good', async () => {
    await requested();
    const [link] = emailedLinks();
    const job = await jobOf(MERCHANT_MAIL_EVENTS.email_verification);
    const processor = t.app.get(EmailVerificationMailProcessor);

    // The link was used.
    expect((await portal().verifyEmail(link!.token)).statusCode).toBe(204);
    expect(await processJob(processor, job)).toEqual({ sent: false, skipped: 'link_not_usable' });

    // A suspended merchant gets no mail; a merchant that is gone gets none either.
    const { db } = await testDb();
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, link!.clientId));
    expect(await processJob(processor, job)).toEqual({ sent: false, skipped: 'account_not_active' });
    await db.delete(s.clients).where(eq(s.clients.id, link!.clientId));
    expect(await processJob(processor, job)).toEqual({ sent: false, skipped: 'account_gone' });
    expect(mailbox(t).sent).toEqual([]);

    const broken = { data: { ...job.data, payload: {} } };
    await expectRejection(processJob(processor, broken), UnrecoverableError);
  });

  for (const how of ['switched off', 'missing'] as const) {
    it(`sends the shipped verification text when the template is ${how}, with a link that works (decision 047)`, async () => {
      const { db } = await testDb();
      await requested();
      const job = await jobOf(MERCHANT_MAIL_EVENTS.email_verification);
      const processor = t.app.get(EmailVerificationMailProcessor);
      const event = eq(s.notificationTemplates.event, 'merchant.email_verification');
      if (how === 'switched off') await db.update(s.notificationTemplates).set({ isActive: false }).where(event);
      else await db.delete(s.notificationTemplates).where(event);

      expect(await processJob(processor, job)).toEqual({ sent: true });
      expect(mailbox(t).sent).toHaveLength(1);
      expect(mailbox(t).sent[0]).toMatchObject({ to: 'ali.hassan@example.com', subject: 'Confirm your email address' });
      const delivered = tokenIn(mailbox(t).sent[0]!.text);
      expect((await portal().verifyEmail(delivered)).statusCode).toBe(204);
      expect(await db.select().from(s.notifications)).toMatchObject([
        { status: 'sent', event: 'merchant.email_verification' },
      ]);
      // The warning says why the shipped text was used, and holds no text and no link.
      const warning = logSink.lines.filter((line) => String(line.msg).includes('the shipped text is used')).at(-1);
      expect(String(warning?.msg)).toContain(how === 'missing' ? 'no stored template' : 'switched off');
      expect(String(warning?.msg)).not.toContain(delivered);
    });
  }

  it('finish the row an earlier attempt made as failed, with the skip reason, when a retry ends skipped', async () => {
    await requested();
    const job = await jobOf(MERCHANT_MAIL_EVENTS.email_verification);
    const processor = t.app.get(EmailVerificationMailProcessor);
    const { db } = await testDb();
    const rows = () => db.select().from(s.notifications);

    // Attempt 1: the mail server is busy, so the row stays queued and the job is retried.
    mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
    await expectRejection(processJob(processor, job, 0), 'The mail server is busy.');
    expect(await rows()).toMatchObject([{ status: 'queued', attempts: 1, error: null }]);

    // Before the retry the link was used (attempt 1 rotated its token, so the row is marked used directly), so attempt 2 ends skipped
    // and the row must not stay queued.
    await db.update(s.authTokens).set({ usedAt: clock.now() });
    expect(await processJob(processor, job, 1)).toEqual({ sent: false, skipped: 'link_not_usable' });
    expect(await rows()).toMatchObject([{ status: 'failed', attempts: 1, error: 'link_not_usable' }]);
    expect(mailbox(t).sent).toEqual([]);

    // A third run finds a finished row and leaves it as it is.
    expect(await processJob(processor, job, 2)).toEqual({ sent: false, skipped: 'link_not_usable' });
    expect(await rows()).toMatchObject([{ status: 'failed', error: 'link_not_usable' }]);
  });

  it('a retry after the template was switched off still sends the shipped text, and the row ends sent (decision 047)', async () => {
    await requested();
    const job = await jobOf(MERCHANT_MAIL_EVENTS.email_verification);
    const processor = t.app.get(EmailVerificationMailProcessor);
    const { db } = await testDb();

    mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
    await expectRejection(processJob(processor, job, 0), 'The mail server is busy.');
    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'merchant.email_verification'));
    expect(await processJob(processor, job, 1)).toEqual({ sent: true });
    expect(await db.select().from(s.notifications)).toMatchObject([{ status: 'sent', attempts: 2, error: null }]);
    expect(mailbox(t).sent).toHaveLength(1);
  });

  it('retry when the mail server fails, mark the row failed on the last attempt, and send a reset and an invitation through their own processors', async () => {
    const merchant = await makeMerchant(t, { noPassword: true });
    const outbox = t.app.get(AccountMailOutbox);
    const issue = t.app.get(AccountAuthTokens);
    for (const [kind, purpose] of [
      ['password_reset', 'reset'],
      ['invited', 'invite'],
    ] as const) {
      await t.app.get(DbService).runInTransaction(async (work) => {
        const issued = await issue.issue(work, { accountId: merchant.id, purpose });
        await outbox.enqueue(work, { kind, accountId: merchant.id, tokenId: issued.tokenId });
      });
    }
    // The invitation is the newest link of the family, so the reset link was replaced: only the invitation is sent.
    expect(await processJob(t.app.get(PasswordResetMailProcessor), await jobOf('merchant.password_reset'))).toEqual({
      sent: false,
      skipped: 'link_not_usable',
    });
    const invited = await jobOf('merchant.invited');
    expect(await processJob(t.app.get(MerchantInvitedMailProcessor), invited)).toEqual({ sent: true });
    expect(mailbox(t).sent[0]).toMatchObject({ subject: 'Your GSM merchant account is ready' });

    // A transient failure: the first four attempts keep the row queued and throw, the fifth marks it failed.
    const { db } = await testDb();
    await db.delete(s.notifications);
    for (let attempt = 0; attempt < 5; attempt++) {
      mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
      await expectRejection(
        processJob(t.app.get(MerchantInvitedMailProcessor), invited, attempt),
        'The mail server is busy.',
      );
      const [row] = await db.select().from(s.notifications);
      expect(row).toMatchObject({ attempts: attempt + 1, status: attempt === 4 ? 'failed' : 'queued' });
    }
    const [row] = await db.select().from(s.notifications);
    expect(row!.error).toBe('The mail server is busy.');
  });
});
