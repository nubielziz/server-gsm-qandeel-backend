// Integration tests of the merchant registration (feature 2b, routes POST /client/auth/register and /verify-email, MISMATCHES
// B122, B123) through HTTP on the real application: one answer for a new and a known email, the merchant with its wallet and
// verification link in one transaction, the outbox event with ids only, and the mail job that follows it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
import { DiscoveryService, ModulesContainer } from '@nestjs/core';
import { and, asc, eq } from 'drizzle-orm';
import { TokenService } from '../../src/infra/crypto';
import { PasswordHasher } from '../../src/infra/crypto';
import { DbService, schema as s } from '../../src/infra/db';
import { UnrecoverableError } from '../../src/infra/queues';
import { buildProcessorTable, findQueueProcessors } from '../../src/infra/queues/queue-processor';
import { MerchantMailOutbox } from '../../src/modules/identity/application/mail/merchant-mail-outbox';
import {
  EmailVerificationMailProcessor,
  MerchantInvitedMailProcessor,
  PasswordResetMailProcessor,
} from '../../src/modules/identity/jobs/merchant-mail.processors';
import { MERCHANT_MAIL_EVENTS, MerchantAuthTokens } from '../../src/modules/identity';
import { DeliveryError, OutboxRouteRegistry, type OutboxJobData } from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, productionEnvOnTestInstances } from '../support/auth';
import { HOUR, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { logSink } from '../support/log-sink';
import {
  MerchantPortal,
  PORTAL_ORIGIN,
  captureEmailedLinks,
  clearPortalRateLimits,
  clientRow,
  emailedLinks,
  makeMerchant,
  seedPortalBasics,
} from '../support/merchant-portal';
import { mailbox, seedDefaultTemplates, tokenIn } from '../support/notifications';
import { freshClientIp } from '../support/pipeline-routes';
import { expectRejection } from '../support/rejection';

const clock = new TestClock();
let t: TestApp;
let defaultGroupId: number;

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
  defaultGroupId = await seedPortalBasics();
  await seedDefaultTemplates((await testDb()).db);
  mailbox(t).reset();
});

const portal = (ip?: string) => new MerchantPortal(t, ip ?? freshClientIp());
const problem = (res: { json: () => unknown }) => res.json() as { code: string; errors?: Array<{ field: string }> };
const form = (over: Record<string, unknown> = {}) => ({
  name: 'Ali Hassan',
  email: 'Ali.Hassan@Example.com',
  password: 'a-long-password',
  company: 'Hassan Mobile',
  phone: '+962791234567',
  country: 'jo',
  ...over,
});

describe('POST /client/auth/register', () => {
  it('creates a pending merchant with its wallet, a verification link and the mail event, in one go', async () => {
    const res = await portal().register(form());
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    const { db } = await testDb();
    const [client] = await db.select().from(s.clients);
    expect(client).toMatchObject({
      email: 'ali.hassan@example.com',
      name: 'Ali Hassan',
      company: 'Hassan Mobile',
      phone: '+962791234567',
      country: 'JO',
      status: 'pending',
      kycStatus: 'none',
      groupId: defaultGroupId,
      twofaEnabled: false,
      totpSecretEnc: null,
      emailVerifiedAt: null,
      referredById: null,
    });
    expect(client!.username).toMatch(/^alihassan\d{5}$/);
    expect(client!.referralCode).toMatch(/^GSM[A-HJ-NP-Z2-9]{6}$/);
    expect(client!.passwordHash).toStartWith('$argon2id$');
    expect(client!.passwordChangedAt?.getTime()).toBe(clock.nowMs());

    // The wallet exists from the first moment (RESOLUTIONS identity-platform-1).
    const accounts = await db
      .select({ kind: s.ledgerAccounts.kind, limit: s.ledgerAccounts.overdraftLimit })
      .from(s.ledgerAccounts)
      .where(and(eq(s.ledgerAccounts.ownerType, 'client'), eq(s.ledgerAccounts.ownerId, client!.id)))
      .orderBy(asc(s.ledgerAccounts.kind));
    expect(accounts).toEqual([
      { kind: 'client_hold', limit: '0.0000' },
      { kind: 'client_wallet', limit: '0.0000' },
    ]);

    // One verification link: a keyed hash, one hour, never the token itself.
    const [link] = await db.select().from(s.authTokens);
    expect(link).toMatchObject({ purpose: 'verify_email', subjectType: 'client', subjectId: client!.id, usedAt: null });
    expect(link!.expiresAt.getTime()).toBe(clock.nowMs() + HOUR);
    const [sent] = emailedLinks();
    expect(sent).toMatchObject({ kind: 'email_verification', clientId: client!.id });
    expect(link!.tokenHash).toBe(t.app.get(TokenService).hash(sent!.token));
    expect(link!.tokenHash).not.toContain(sent!.token);

    // The outbox event carries ids only.
    const [event] = await db.select().from(s.outboxEvents);
    expect(event).toMatchObject({
      type: 'merchant.email_verification',
      aggregateType: 'clients',
      aggregateId: client!.id,
      processedAt: null,
    });
    expect(event!.payload.tokenId).toBe(link!.id);
    expect(JSON.stringify(event!.payload)).not.toContain(sent!.token);
    expect(JSON.stringify(event!.payload)).not.toContain('example.com');
  });

  it('gives a known email exactly the answer a new one gets and changes nothing', async () => {
    const first = await portal().register(form());
    const again = await portal().register(form({ email: 'ALI.HASSAN@example.COM', name: 'Someone Else' }));
    const strip = (res: typeof first) => ({
      status: res.statusCode,
      body: res.body,
      type: res.headers['content-type'],
      cache: res.headers['cache-control'],
    });
    expect(strip(again)).toEqual(strip(first));

    const { db } = await testDb();
    expect(await db.select().from(s.clients)).toHaveLength(1);
    expect((await db.select().from(s.clients))[0]!.name).toBe('Ali Hassan');
    expect(await db.select().from(s.authTokens)).toHaveLength(1);
    expect(await db.select().from(s.outboxEvents)).toHaveLength(1);
    expect(emailedLinks()).toHaveLength(1);
  });

  it('hashes the password whether or not the email is known, so the timing does not tell them apart', async () => {
    const hasher = t.app.get(PasswordHasher);
    const hash = spyOn(hasher, 'hash');
    await portal().register(form());
    const before = hash.mock.calls.length;
    await portal().register(form());
    expect(hash.mock.calls.length - before).toBe(1);
    hash.mockRestore();
  });

  it('creates one merchant when two requests register the same new email at once', async () => {
    const [a, b] = await Promise.all([portal().register(form()), portal().register(form())]);
    expect([a.statusCode, b.statusCode]).toEqual([204, 204]);
    const { db } = await testDb();
    expect(await db.select().from(s.clients)).toHaveLength(1);
    expect(await db.select().from(s.authTokens)).toHaveLength(1);
    expect(await db.select().from(s.outboxEvents)).toHaveLength(1);
  });

  it('links the merchant that owns the referral code, whatever its case', async () => {
    const referrer = await makeMerchant(t, { referralCode: 'GSMTEST1' });
    expect((await portal().register(form({ referralCode: 'gsmtest1' }))).statusCode).toBe(204);
    const { db } = await testDb();
    const [created] = await db.select().from(s.clients).where(eq(s.clients.email, 'ali.hassan@example.com'));
    expect(created!.referredById).toBe(referrer.id);
  });

  it('answers 422 on the field for a form that is wrong, and nothing is created', async () => {
    const empty = await portal().register({});
    expect(empty.statusCode).toBe(422);
    expect(problem(empty).code).toBe('VALIDATION_FAILED');
    expect(
      problem(empty)
        .errors?.map((e) => e.field)
        .sort(),
    ).toEqual(['country', 'email', 'name', 'password']);

    const badEmail = await portal().register(form({ email: 'not-an-email' }));
    expect(problem(badEmail).errors?.map((e) => e.field)).toEqual(['email']);
    const badCountry = await portal().register(form({ country: 'JOR' }));
    expect(problem(badCountry).errors?.map((e) => e.field)).toEqual(['country']);

    const unknownCode = await portal().register(form({ referralCode: 'NOBODY' }));
    expect(unknownCode.statusCode).toBe(422);
    expect(problem(unknownCode).code).toBe('VALIDATION_FAILED');
    expect(problem(unknownCode).errors?.map((e) => e.field)).toEqual(['referralCode']);

    const weak = await portal().register(form({ password: 'password123' }));
    expect(weak.statusCode).toBe(422);
    expect(problem(weak).code).toBe('WEAK_PASSWORD');
    expect(problem(weak).errors?.map((e) => e.field)).toEqual(['password']);
    const short = await portal().register(form({ password: 'short' }));
    expect(problem(short).code).toBe('WEAK_PASSWORD');
    const { db } = await testDb();
    expect(await db.select().from(s.clients)).toHaveLength(0);
  });

  it('refuses a request that does not come from the portal: 403 CSRF_FAILED', async () => {
    expect(problem(await portal().register(form(), { origin: false })).code).toBe('CSRF_FAILED');
    const other = await portal().register(form(), { origin: 'https://evil.example.com' });
    expect(other.statusCode).toBe(403);
    expect(problem(other).code).toBe('CSRF_FAILED');
  });

  it('counts registrations per address, known email or not: the sixth is 429 with Retry-After', async () => {
    const ip = freshClientIp();
    for (let i = 0; i < 5; i++) {
      expect((await portal(ip).register(form({ email: `merchant${i}@example.com` }))).statusCode, `try ${i + 1}`).toBe(
        204,
      );
    }
    const sixth = await portal(ip).register(form({ email: 'merchant0@example.com' }));
    expect(sixth.statusCode).toBe(429);
    expect(problem(sixth).code).toBe('RATE_LIMITED');
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Another address is not affected.
    expect((await portal().register(form({ email: 'other@example.com' }))).statusCode).toBe(204);
  });

  it('never writes a link or a token to the log, in development or in production, and still writes the outbox event', async () => {
    const log = spyOn(Logger.prototype, 'log');
    const warn = spyOn(Logger.prototype, 'warn');
    await portal().register(form());
    const [link] = emailedLinks();
    const text = [...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0])).join('\n');
    expect(text).not.toContain(link!.token);
    expect(text).not.toContain('DEVELOPMENT ONLY');
    expect(text).not.toContain('verify-email?token');

    const production = await createTestApp({
      env: productionEnvOnTestInstances({ CORS_ORIGINS: PORTAL_ORIGIN }),
      clock,
    });
    try {
      const res = await new MerchantPortal(production, freshClientIp()).register(
        form({ email: 'prod.merchant@example.com' }),
      );
      expect(res.statusCode).toBe(204);
      const { db } = await testDb();
      expect(await db.select().from(s.outboxEvents)).toHaveLength(2);
      expect([...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0])).join('\n')).not.toContain('token=');
    } finally {
      await production.close();
    }
  });
});

describe('POST /client/auth/verify-email', () => {
  async function registered() {
    await portal().register(form());
    const [link] = emailedLinks();
    return { token: link!.token, clientId: link!.clientId };
  }

  it('marks the email verified once, keeps the merchant pending and signs nobody in', async () => {
    const { token, clientId } = await registered();
    clock.advance(10 * 60_000);
    const p = portal();
    const res = await p.verifyEmail(token);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.cookies).toEqual([]);
    expect(await clientRow(clientId)).toMatchObject({ status: 'pending' });
    expect((await clientRow(clientId)).emailVerifiedAt?.getTime()).toBe(clock.nowMs());

    const used = await portal().verifyEmail(token);
    expect(used.statusCode).toBe(410);
    expect(problem(used).code).toBe('TOKEN_INVALID');
    const { db } = await testDb();
    expect((await db.select().from(s.authTokens))[0]!.usedAt?.getTime()).toBe(clock.nowMs());
  });

  it('refuses an unknown link, an expired one and a link of another purpose with the same 410', async () => {
    const { token, clientId } = await registered();
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
    const { token, clientId } = await registered();
    const missing = await portal().call('POST', '/client/auth/verify-email', {});
    expect(missing.statusCode).toBe(422);
    expect(problem(missing).errors?.map((e) => e.field)).toEqual(['token']);

    const results = await Promise.all([portal().verifyEmail(token), portal().verifyEmail(token)]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([204, 410]);
    expect((await clientRow(clientId)).emailVerifiedAt).not.toBeNull();
  });
});

describe('the merchant mail events', () => {
  it('are registered with the notifications queue, and each has one named processor in the worker table', () => {
    const routes = t.app.get(OutboxRouteRegistry);
    for (const type of Object.values(MERCHANT_MAIL_EVENTS)) {
      expect(routes.get(type), type).toMatchObject({ type, queue: 'notifications' });
    }
    const table = buildProcessorTable(findQueueProcessors(new DiscoveryService(t.app.get(ModulesContainer))));
    // The queue is shared: the customer mails (feature 14b) have named processors of their own on it.
    const named = [...(table.get('notifications')?.byName.keys() ?? [])]
      .filter((name) => !name.startsWith('customer.'))
      .sort();
    // The notifications queue has named processors only: the three merchant mails, the two jobs of feature 12a and the ticket mail of
    // feature 17.
    expect(named).toEqual(
      [...Object.values(MERCHANT_MAIL_EVENTS), 'notification.plan', 'notification.send', 'support.ticket_mail'].sort(),
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
    await portal().register(form());
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
    expect(mail!.text).toContain(`${t.config.http.portalBaseUrl}/verify-email?token=`);
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
      recipientType: 'client',
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
    await portal().register(form());
    const job = await jobOf(MERCHANT_MAIL_EVENTS.email_verification);
    const processor = t.app.get(EmailVerificationMailProcessor);
    expect(await processJob(processor, job)).toEqual({ sent: true });
    const delivered = tokenIn(mailbox(t).sent[0]!.text);

    expect(await processJob(processor, job, 1)).toEqual({ sent: false, skipped: 'already_sent' });
    expect(mailbox(t).sent).toHaveLength(1);
    expect((await portal().verifyEmail(delivered)).statusCode).toBe(204);
  });

  it('skip a mail that is no longer worth sending, and fail a job that lost its token id for good', async () => {
    await portal().register(form());
    const [link] = emailedLinks();
    const job = await jobOf(MERCHANT_MAIL_EVENTS.email_verification);
    const processor = t.app.get(EmailVerificationMailProcessor);

    // The link was used.
    expect((await portal().verifyEmail(link!.token)).statusCode).toBe(204);
    expect(await processJob(processor, job)).toEqual({ sent: false, skipped: 'link_not_usable' });

    // A suspended merchant gets no mail; a merchant that is gone gets none either.
    const { db } = await testDb();
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, link!.clientId));
    expect(await processJob(processor, job)).toEqual({ sent: false, skipped: 'merchant_suspended' });
    await db.delete(s.clients).where(eq(s.clients.id, link!.clientId));
    expect(await processJob(processor, job)).toEqual({ sent: false, skipped: 'merchant_gone' });
    expect(mailbox(t).sent).toEqual([]);

    const broken = { data: { ...job.data, payload: {} } };
    await expectRejection(processJob(processor, broken), UnrecoverableError);
  });

  it('send nothing, and keep the link as it is, when the template is missing or switched off', async () => {
    await portal().register(form());
    const [link] = emailedLinks();
    const job = await jobOf(MERCHANT_MAIL_EVENTS.email_verification);
    const processor = t.app.get(EmailVerificationMailProcessor);
    const { db } = await testDb();
    const [before] = await db.select().from(s.authTokens);

    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'merchant.email_verification'));
    expect(await processJob(processor, job)).toEqual({ sent: false, skipped: 'template_off' });
    await db.delete(s.notificationTemplates).where(eq(s.notificationTemplates.event, 'merchant.email_verification'));
    expect(await processJob(processor, job)).toEqual({ sent: false, skipped: 'no_template' });

    expect(mailbox(t).sent).toEqual([]);
    expect(await db.select().from(s.notifications)).toEqual([]);
    const [after] = await db.select().from(s.authTokens);
    expect(after!.tokenHash).toBe(before!.tokenHash);
    expect((await portal().verifyEmail(link!.token)).statusCode).toBe(204);
  });

  it('finish the row an earlier attempt made as failed, with the skip reason, when a retry ends skipped', async () => {
    await portal().register(form());
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

  it('finish the queued row of an earlier attempt as failed when the template was switched off before the retry', async () => {
    await portal().register(form());
    const job = await jobOf(MERCHANT_MAIL_EVENTS.email_verification);
    const processor = t.app.get(EmailVerificationMailProcessor);
    const { db } = await testDb();

    mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
    await expectRejection(processJob(processor, job, 0), 'The mail server is busy.');
    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'merchant.email_verification'));
    expect(await processJob(processor, job, 1)).toEqual({ sent: false, skipped: 'template_off' });
    expect(await db.select().from(s.notifications)).toMatchObject([{ status: 'failed', error: 'template_off' }]);
  });

  it('retry when the mail server fails, mark the row failed on the last attempt, and send a reset and an invitation through their own processors', async () => {
    const merchant = await makeMerchant(t, { status: 'pending', noPassword: true });
    const outbox = t.app.get(MerchantMailOutbox);
    const issue = t.app.get(MerchantAuthTokens);
    for (const [kind, purpose] of [
      ['password_reset', 'reset'],
      ['invited', 'invite'],
    ] as const) {
      await t.app.get(DbService).runInTransaction(async (work) => {
        const issued = await issue.issue(work, { clientId: merchant.id, purpose });
        await outbox.enqueue(work, { kind, clientId: merchant.id, tokenId: issued.id });
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
