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
import { LogMailSender } from '../../src/modules/identity/application/mail/log-mail-sender';
import { MerchantMailOutbox } from '../../src/modules/identity/application/mail/merchant-mail-outbox';
import {
  EmailVerificationMailProcessor,
  MerchantInvitedMailProcessor,
  PasswordResetMailProcessor,
} from '../../src/modules/identity/jobs/merchant-mail.processors';
import { MERCHANT_MAIL_EVENTS, MerchantAuthTokens } from '../../src/modules/identity';
import { OutboxRouteRegistry, type OutboxJobData } from '../../src/modules/platform';
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

  it('prints the link to the log outside production, for a developer without a mail transport', async () => {
    const log = spyOn(Logger.prototype, 'log');
    await portal().register(form());
    const [link] = emailedLinks();
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain(
      `DEVELOPMENT ONLY: merchant.email_verification link for client ${link!.clientId}: ` +
        `${t.config.http.portalBaseUrl}/verify-email?token=${encodeURIComponent(link!.token)}`,
    );
  });

  it('writes no link into the log in production, and still writes the outbox event', async () => {
    const production = await createTestApp({
      env: productionEnvOnTestInstances({ CORS_ORIGINS: PORTAL_ORIGIN }),
      clock,
    });
    try {
      const log = spyOn(Logger.prototype, 'log');
      const res = await new MerchantPortal(production, freshClientIp()).register(form());
      expect(res.statusCode).toBe(204);
      expect(log.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('DEVELOPMENT ONLY');
      const { db } = await testDb();
      expect(await db.select().from(s.outboxEvents)).toHaveLength(1);
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
    const named = [...(table.get('notifications')?.byName.keys() ?? [])].sort();
    expect(named).toEqual(Object.values(MERCHANT_MAIL_EVENTS).sort());
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

  it('hand a registration mail to the sender with ids and the merchant, and log a redacted line without the token', async () => {
    await portal().register(form());
    const [link] = emailedLinks();
    const sender = t.app.get(LogMailSender);
    const send = spyOn(sender, 'send');
    const log = spyOn(Logger.prototype, 'log');

    const result = await t.app
      .get(EmailVerificationMailProcessor)
      .process((await jobOf(MERCHANT_MAIL_EVENTS.email_verification)) as never);
    expect(result).toEqual({ sent: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      kind: 'email_verification',
      clientId: link!.clientId,
      email: 'ali.hassan@example.com',
      name: 'Ali Hassan',
    });
    const logged = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('merchant.email_verification');
    expect(logged).toContain('a***@example.com');
    expect(logged).not.toContain('ali.hassan@example.com');
    expect(logged).not.toContain(link!.token);
    send.mockRestore();
  });

  it('skip a mail that is no longer worth sending, and fail a job that lost its token id for good', async () => {
    await portal().register(form());
    const [link] = emailedLinks();
    const job = (await jobOf(MERCHANT_MAIL_EVENTS.email_verification)) as never;
    const processor = t.app.get(EmailVerificationMailProcessor);

    // The link was used.
    expect((await portal().verifyEmail(link!.token)).statusCode).toBe(204);
    expect(await processor.process(job)).toEqual({ sent: false, skipped: 'link_not_usable' });

    // A suspended merchant gets no mail; a merchant that is gone gets none either.
    const { db } = await testDb();
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, link!.clientId));
    expect(await processor.process(job)).toEqual({ sent: false, skipped: 'merchant_suspended' });
    await db.delete(s.clients).where(eq(s.clients.id, link!.clientId));
    expect(await processor.process(job)).toEqual({ sent: false, skipped: 'merchant_gone' });

    const broken = { data: { ...(job as { data: OutboxJobData }).data, payload: {} } } as never;
    await expectRejection(processor.process(broken), UnrecoverableError);
  });

  it('retry when the sender fails, and send a reset and an invitation mail through their own processors', async () => {
    const merchant = await makeMerchant(t, { status: 'pending', noPassword: true });
    const outbox = t.app.get(MerchantMailOutbox);
    const issue = t.app.get(MerchantAuthTokens);
    for (const [kind, purpose] of [
      ['password_reset', 'reset'],
      ['invited', 'invite'],
    ] as const) {
      await t.app.get(DbService).runInTransaction(async (work) => {
        const issued = await issue.issue(work, { clientId: merchant.id, purpose });
        await outbox.enqueue(work, { kind, clientId: merchant.id, tokenId: issued.id, token: issued.token });
      });
    }
    const sender = t.app.get(LogMailSender);
    const send = spyOn(sender, 'send');
    // The invitation is the newest link of the family, so the reset link was replaced: only the invitation is sent.
    expect(
      await t.app.get(PasswordResetMailProcessor).process((await jobOf('merchant.password_reset')) as never),
    ).toEqual({
      sent: false,
      skipped: 'link_not_usable',
    });
    expect(await t.app.get(MerchantInvitedMailProcessor).process((await jobOf('merchant.invited')) as never)).toEqual({
      sent: true,
    });
    expect(send.mock.calls[0]![0]).toMatchObject({ kind: 'invited', clientId: merchant.id });

    send.mockRejectedValueOnce(new Error('smtp is down'));
    await expectRejection(
      t.app.get(MerchantInvitedMailProcessor).process((await jobOf('merchant.invited')) as never),
      'smtp is down',
    );
    send.mockRestore();
  });
});
