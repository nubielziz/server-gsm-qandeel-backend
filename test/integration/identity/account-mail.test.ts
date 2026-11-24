// Integration tests of the account link mails (features 2b, 12a and 14b, decision 064): the seven outbox event types are registered with the
// notifications queue and each has one named processor; the mail of an account is chosen by its rank kind (merchant or retail) when the
// event is written; for each kind the job rotates the link's token, sends one email through the notification delivery whose link works,
// never holds the clear token in the database or the log, sends once when it runs twice, and sends nothing for an account that cannot act,
// a link that was used, voided or has expired, an account that changed rank, or a job of the retired customer table; a merchant mail queued
// before the cut-over is still sent; a missing or switched-off template does not stop the mail (decision 047).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
import { DiscoveryService, ModulesContainer } from '@nestjs/core';
import { and, asc, eq } from 'drizzle-orm';
import { TokenService } from '@src/infra/crypto';
import { DbService, type Database, schema as s } from '@src/infra/db';
import { UnrecoverableError } from '@src/infra/queues';
import { buildProcessorTable, findQueueProcessors } from '@src/infra/queues/queue-processor';
import { AccountAuthTokens, AccountMailOutbox, type AccountMailKind, type RankKind } from '@src/modules/identity';
import {
  ACCOUNT_MAIL_EVENTS,
  ACCOUNT_MAIL_EVENT_TYPES,
  ACCOUNT_MAIL_PURPOSES,
  accountMailEventOf,
} from '@src/modules/identity/domain/account-mail';
import { NO_ACCOUNT_ID } from '@src/modules/identity/domain/public-links';
import {
  CustomerEmailVerificationMailProcessor,
  CustomerInvitedMailProcessor,
  CustomerPasswordResetMailProcessor,
  MagicLinkMailProcessor,
  MerchantEmailVerificationMailProcessor,
  MerchantInvitedMailProcessor,
  MerchantPasswordResetMailProcessor,
} from '@src/modules/identity/jobs/account-mail.processors';
import {
  CUSTOMER_MAIL_EVENT_KEYS,
  DeliveryError,
  MERCHANT_MAIL_EVENT_KEYS,
  OutboxRouteRegistry,
  type OutboxJobData,
} from '@src/modules/platform';
import { accountRow, ensureMerchantGroup, ensureRetailGroup, makeAccount } from '../../support/accounts';
import { captureAccountLinks, accountLinks } from '../../support/account-links';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { HOUR, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { clearAccountMailLimits, seedIdentityTemplates } from '../../support/identity-mail';
import { logSink } from '../../support/log-sink';
import { mailbox, tokenIn } from '../../support/notifications';
import { expectRejection } from '../../support/rejection';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearAccountMailLimits(t);
  // resetDb empties `notification_templates`: the mails need the templates the migrations ship.
  await seedIdentityTemplates((await testDb()).db);
  logSink.clear();
  mailbox(t).reset();
  captureAccountLinks(t);
});
afterEach(() => mock.restore());

/** The BullMQ job the relay would make from the stored outbox event of this type for this account. */
async function jobOf(type: string, accountId: number): Promise<{ data: OutboxJobData }> {
  const { db } = await testDb();
  const [event] = await db
    .select()
    .from(s.outboxEvents)
    .where(and(eq(s.outboxEvents.type, type), eq(s.outboxEvents.aggregateId, accountId)))
    .orderBy(asc(s.outboxEvents.id));
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

/** Runs a mail job the way the worker would: with its attempt number and the queue's maximum. */
const processJob = (
  processor: { process(job: never): Promise<unknown> },
  job: { data: OutboxJobData },
  attemptsMade = 0,
) => processor.process({ ...job, attemptsMade, opts: { attempts: 5 } } as never);

/** Every text a stored row, a log line or a mail could hold the clear token in. */
async function everythingStored(): Promise<string> {
  const { db } = await testDb();
  const tables = [
    await db.select().from(s.notifications),
    await db.select().from(s.outboxEvents),
    await db.select().from(s.authTokens),
    await db.select().from(s.auditLogs),
  ];
  return JSON.stringify(tables) + JSON.stringify(logSink.lines);
}

/** Tells whether a token is a working link of an account for a purpose, without spending it. */
async function linkWorks(token: string, kind: AccountMailKind): Promise<number | undefined> {
  return t.app.get(DbService).runInTransaction(async (work) => {
    const taken = await t.app.get(AccountAuthTokens).take(work.tx, token, [ACCOUNT_MAIL_PURPOSES[kind]]);
    return taken?.accountId;
  });
}

/** One of the seven mails: who gets it, what its event, processor and text are. */
interface Flow {
  readonly rank: RankKind;
  readonly kind: AccountMailKind;
  readonly processor: new (...args: never[]) => { process(job: never): Promise<unknown> };
  readonly subject: string;
  /** The path of the shop page the link opens. */
  readonly path: string;
  readonly name: string;
}

const FLOWS: readonly Flow[] = [
  {
    rank: 'merchant',
    kind: 'email_verification',
    processor: MerchantEmailVerificationMailProcessor,
    subject: 'Confirm your email address',
    path: '/verify-email',
    name: 'Ali Hassan',
  },
  {
    rank: 'merchant',
    kind: 'password_reset',
    processor: MerchantPasswordResetMailProcessor,
    subject: 'Reset your password',
    path: '/set-password',
    name: 'Ali Hassan',
  },
  {
    rank: 'merchant',
    kind: 'invited',
    processor: MerchantInvitedMailProcessor,
    subject: 'Your GSM merchant account is ready',
    path: '/set-password',
    name: 'Ali Hassan',
  },
  {
    rank: 'retail',
    kind: 'magic_link',
    processor: MagicLinkMailProcessor,
    subject: 'Your sign-in link',
    path: '/sign-in',
    name: 'Daniel Whitmore',
  },
  {
    rank: 'retail',
    kind: 'password_reset',
    processor: CustomerPasswordResetMailProcessor,
    subject: 'Reset your password',
    path: '/set-password',
    name: 'Maya Cohen',
  },
  {
    rank: 'retail',
    kind: 'invited',
    processor: CustomerInvitedMailProcessor,
    subject: 'Your GSM account is ready',
    path: '/set-password',
    name: 'Lukas Brandt',
  },
  {
    rank: 'retail',
    kind: 'email_verification',
    processor: CustomerEmailVerificationMailProcessor,
    subject: 'Confirm your email address',
    path: '/verify-email',
    name: 'Sara Haddad',
  },
];

/**
 * Makes the account and queues the mail the way a use case does: the link and its outbox event in one transaction of the seams.
 *
 * @param rank the rank kind of the account
 * @param kind which mail
 * @param name the account's name
 * @returns the account, and the placeholder token the request made
 */
async function queue(rank: RankKind, kind: AccountMailKind, name: string) {
  const account = await makeAccount(t, { rank, name, password: null, emailVerifiedAt: null });
  const placeholder = await queueFor(account.id, kind);
  return { account, placeholder };
}

/** Issues the link of a kind for an account and writes its mail event; returns the placeholder token. */
async function queueFor(accountId: number, kind: AccountMailKind): Promise<string> {
  const tokens = t.app.get(AccountAuthTokens);
  const outbox = t.app.get(AccountMailOutbox);
  return t.app.get(DbService).runInTransaction(async (work) => {
    const issued = await tokens.issue(work, { accountId, purpose: ACCOUNT_MAIL_PURPOSES[kind] });
    await outbox.enqueue(work, { kind, accountId, tokenId: issued.tokenId });
    return issued.token;
  });
}

describe('the account mail events', () => {
  it('are registered with the notifications queue, and each has one named processor in the worker table', () => {
    const routes = t.app.get(OutboxRouteRegistry);
    for (const type of ACCOUNT_MAIL_EVENT_TYPES) {
      expect(routes.get(type), type).toMatchObject({ type, queue: 'notifications' });
    }
    const table = buildProcessorTable(findQueueProcessors(new DiscoveryService(t.app.get(ModulesContainer))));
    const named = [...(table.get('notifications')?.byName.keys() ?? [])]
      .filter((name) => name.startsWith('customer.') || name.startsWith('merchant.'))
      .sort();
    expect(named).toEqual([...ACCOUNT_MAIL_EVENT_TYPES].sort());
    expect(table.get('notifications')?.catchAll).toBeUndefined();
    // The platform's registry keeps its own copy of the keys: the copies must never drift apart.
    expect([...CUSTOMER_MAIL_EVENT_KEYS].sort()).toEqual(Object.values(ACCOUNT_MAIL_EVENTS.retail).sort());
    expect([...MERCHANT_MAIL_EVENT_KEYS].sort()).toEqual(Object.values(ACCOUNT_MAIL_EVENTS.merchant).sort());
  });

  it('are chosen by the rank kind of the account when the event is written: invites of a retail and of a merchant account', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant', password: null });
    const shopper = await makeAccount(t, { rank: 'retail', password: null });
    await queueFor(merchant.id, 'invited');
    await queueFor(shopper.id, 'invited');
    const { db } = await testDb();
    const events = await db.select().from(s.outboxEvents).orderBy(asc(s.outboxEvents.id));
    expect(events.map((event) => [event.type, event.aggregateType, event.aggregateId])).toEqual([
      ['merchant.invited', 'clients', merchant.id],
      ['customer.invited', 'clients', shopper.id],
    ]);
    // Ids only: the account and the link row, never the token.
    for (const event of events) {
      // Sorted: a jsonb column keeps its keys in its own order (shorter keys first), not in the order they were written.
      expect(
        Object.keys(event.payload)
          .filter((key) => key !== 'meta')
          .sort(),
      ).toEqual(['accountId', 'tokenId']);
      expect(event.payload).toMatchObject({ accountId: event.aggregateId, tokenId: expect.any(Number) });
    }
  });

  it('write a sign-in link for a retail rank only, and read the rank under the row, never from the caller', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant', password: null });
    const shopper = await makeAccount(t, { rank: 'retail', password: null });
    await expectRejection(queueFor(merchant.id, 'magic_link'), 'not sent to a merchant account');
    await queueFor(shopper.id, 'magic_link');
    const { db } = await testDb();
    expect((await db.select().from(s.outboxEvents)).map((event) => event.type)).toEqual(['customer.magic_link']);
  });

  it('refuse an account that does not exist, but write the retail family for the id a run that is rolled back uses', async () => {
    const outbox = t.app.get(AccountMailOutbox);
    await expectRejection(
      t.app.get(DbService).runInTransaction((work) => outbox.enqueue(work, { kind: 'invited', accountId: 999_999 })),
      'does not exist',
    );
    await t.app
      .get(DbService)
      .runInTransaction((work) => outbox.enqueue(work, { kind: 'magic_link', accountId: NO_ACCOUNT_ID, tokenId: 1 }));
    const { db } = await testDb();
    expect((await db.select().from(s.outboxEvents)).map((event) => event.type)).toEqual(['customer.magic_link']);
  });

  it('fail a job that lost its token id for good, and a job of the retired customer table', async () => {
    const { account } = await queue('retail', 'invited', 'Lukas Brandt');
    const job = await jobOf('customer.invited', account.id);
    const processor = t.app.get(CustomerInvitedMailProcessor);
    await expectRejection(
      processJob(processor, { data: { ...job.data, payload: { accountId: account.id } } }),
      UnrecoverableError,
    );

    // What a customer mail wrote before the cut-over: the customer is the aggregate, the payload names the link only.
    await expectRejection(
      processJob(processor, {
        data: { ...job.data, aggregateType: 'customers', aggregateId: account.id, payload: { tokenId: 1 } },
      }),
      UnrecoverableError,
    );
    expect(mailbox(t).sent).toEqual([]);
  });

  it('send a merchant mail queued before the cut-over: the merchant is the aggregate and the payload names the link only', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant', name: 'Ali Hassan', password: null });
    const placeholder = await queueFor(merchant.id, 'invited');
    const job = await jobOf('merchant.invited', merchant.id);
    const legacy = { data: { ...job.data, payload: { tokenId: job.data.payload['tokenId'] as number } } };
    expect(await processJob(t.app.get(MerchantInvitedMailProcessor), legacy)).toEqual({ sent: true });
    expect(mailbox(t).sent).toHaveLength(1);
    expect(mailbox(t).sent[0]).toMatchObject({ to: merchant.email, subject: 'Your GSM merchant account is ready' });
    expect(tokenIn(mailbox(t).sent[0]!.text)).not.toBe(placeholder);
  });

  it('never write a link or a token to the log, in a request or in a job, whatever the environment', async () => {
    const log = spyOn(Logger.prototype, 'log');
    const warn = spyOn(Logger.prototype, 'warn');
    for (const flow of FLOWS) {
      const { account, placeholder } = await queue(flow.rank, flow.kind, flow.name);
      await processJob(t.app.get(flow.processor), await jobOf(accountMailEventOf(flow.rank, flow.kind), account.id));
      const text = [...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0])).join('\n');
      expect(text).not.toContain(placeholder);
      expect(text).not.toContain(tokenIn(mailbox(t).sent.at(-1)!.text));
    }
    const text = [...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0])).join('\n');
    expect(text).not.toContain('DEVELOPMENT ONLY');
    expect(text).not.toContain('token=');
  });
});

for (const flow of FLOWS) {
  const event: string = accountMailEventOf(flow.rank, flow.kind);
  describe(`${event} (${flow.rank} rank)`, () => {
    const processor = () => t.app.get(flow.processor);
    const rowsOfEvent = (db: Database) => db.select().from(s.notifications).where(eq(s.notifications.event, event));

    /** Queues the mail and returns the account, the job and the row of the link before the job rotates it. */
    async function begin() {
      const { account, placeholder } = await queue(flow.rank, flow.kind, flow.name);
      const { db } = await testDb();
      const [link] = await db.select().from(s.authTokens).where(eq(s.authTokens.subjectId, account.id));
      return { account, placeholder, job: await jobOf(event, account.id), link: link!, db };
    }

    it('sends exactly one email, with a link into the shop that works, and the request’s placeholder is dead', async () => {
      const { account, placeholder, job, link, db } = await begin();
      expect(await linkWorks(placeholder, flow.kind)).toBe(account.id);
      expect(await processJob(processor(), job)).toEqual({ sent: true });

      // One mail to the account's address, in English, with the name, the shop's page and the expiry in the text: the same address for both ranks.
      expect(mailbox(t).sent).toHaveLength(1);
      const [mail] = mailbox(t).sent;
      expect(mail).toMatchObject({ to: account.email, subject: flow.subject });
      expect(mail!.text).toContain(flow.name);
      expect(mail!.text).toContain('2026-11-07 11:00 UTC');
      expect(mail!.text).toContain(`${t.config.http.storeBaseUrl}${flow.path}?token=`);
      const delivered = tokenIn(mail!.text);
      expect(delivered).not.toBe(placeholder);

      // The same row (id, expiry) now holds the hash of the delivered token only.
      const [after] = await db.select().from(s.authTokens).where(eq(s.authTokens.id, link.id));
      expect(after).toMatchObject({ expiresAt: link.expiresAt, usedAt: null, subjectType: 'account' });
      expect(after!.tokenHash).toBe(t.app.get(TokenService).hash(delivered));

      // One `notifications` row logs the mail: the account, attempts and the event's dedupe key, no link.
      expect(await rowsOfEvent(db)).toMatchObject([
        {
          recipientType: 'account',
          recipientId: account.id,
          channel: 'email',
          event,
          status: 'sent',
          attempts: 1,
          dedupeKey: `outbox-${job.data.eventId}:email`,
        },
      ]);
      const stored = await everythingStored();
      expect(stored).not.toContain(delivered);
      expect(stored).not.toContain(placeholder);

      // The delivered link works, and the placeholder does not: it was replaced.
      expect(await linkWorks(delivered, flow.kind)).toBe(account.id);
      expect(await linkWorks(placeholder, flow.kind)).toBeUndefined();
    });

    it('sends once when the job runs twice, and the link that arrived still works', async () => {
      const { account, job, db } = await begin();
      expect(await processJob(processor(), job)).toEqual({ sent: true });
      const delivered = tokenIn(mailbox(t).sent[0]!.text);

      expect(await processJob(processor(), job, 1)).toEqual({ sent: false, skipped: 'already_sent' });
      expect(mailbox(t).sent).toHaveLength(1);
      expect(await rowsOfEvent(db)).toHaveLength(1);
      expect(await linkWorks(delivered, flow.kind)).toBe(account.id);
    });

    it('retries a mail server that fails: one mail in the end, one row, and the last link works', async () => {
      const { account, job, db } = await begin();
      mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
      await expectRejection(processJob(processor(), job, 0), 'The mail server is busy.');
      expect(await rowsOfEvent(db)).toMatchObject([{ status: 'queued', attempts: 1 }]);

      expect(await processJob(processor(), job, 1)).toEqual({ sent: true });
      expect(mailbox(t).sent).toHaveLength(1);
      expect(await rowsOfEvent(db)).toMatchObject([{ status: 'sent', attempts: 2 }]);
      expect(await linkWorks(tokenIn(mailbox(t).sent[0]!.text), flow.kind)).toBe(account.id);
    });

    for (const [status, skipped] of [
      ['suspended', 'account_not_active'],
      ['blocked', 'account_not_active'],
      ['anonymized', 'account_gone'],
    ] as const) {
      it(`sends nothing to a ${status} account and leaves the link as it is`, async () => {
        const { account, job, link, db } = await begin();
        // An anonymized row carries the time of its anonymization (clients_anonymized_check).
        const anonymizedAt = status === 'anonymized' ? new Date() : null;
        await db.update(s.clients).set({ status, anonymizedAt }).where(eq(s.clients.id, account.id));
        expect(await processJob(processor(), job)).toEqual({ sent: false, skipped });
        expect(mailbox(t).sent).toEqual([]);
        expect(await rowsOfEvent(db)).toEqual([]);
        const [after] = await db.select().from(s.authTokens).where(eq(s.authTokens.id, link.id));
        expect(after!.tokenHash).toBe(link.tokenHash);
      });
    }

    it('sends nothing when the account changed rank after the mail was queued: neither text fits any more', async () => {
      const { account, job, link, db } = await begin();
      const other = flow.rank === 'merchant' ? await ensureRetailGroup(db) : await ensureMerchantGroup(db);
      await db.update(s.clients).set({ groupId: other }).where(eq(s.clients.id, account.id));
      expect(await processJob(processor(), job)).toEqual({ sent: false, skipped: 'rank_changed' });
      expect(mailbox(t).sent).toEqual([]);
      const [after] = await db.select().from(s.authTokens).where(eq(s.authTokens.id, link.id));
      expect(after!.tokenHash).toBe(link.tokenHash);
    });

    it('sends nothing to an account that is gone', async () => {
      const { account, job, db } = await begin();
      await db.delete(s.authTokens);
      await db.delete(s.clients).where(eq(s.clients.id, account.id));
      expect(await processJob(processor(), job)).toEqual({ sent: false, skipped: 'account_gone' });
      expect(mailbox(t).sent).toEqual([]);
    });

    it('sends nothing for a link that was used', async () => {
      const { account, job, db } = await begin();
      await db.update(s.authTokens).set({ usedAt: clock.now() }).where(eq(s.authTokens.subjectId, account.id));
      expect(await processJob(processor(), job)).toEqual({ sent: false, skipped: 'link_not_usable' });
      expect(mailbox(t).sent).toEqual([]);
    });

    it('sends nothing for a link that was voided', async () => {
      const { account, job } = await begin();
      await t.app
        .get(DbService)
        .runInTransaction((work) =>
          t.app.get(AccountAuthTokens).voidOpenOf(work.tx, account.id, [ACCOUNT_MAIL_PURPOSES[flow.kind]]),
        );
      expect(await processJob(processor(), job)).toEqual({ sent: false, skipped: 'link_not_usable' });
      expect(mailbox(t).sent).toEqual([]);
    });

    it('sends nothing for a token of another subject type, even when its subject id is the account id', async () => {
      const { account, job, link, db } = await begin();
      // A link of a staff member whose number equals the account's is not the account's link (the two id spaces overlap).
      await db.update(s.authTokens).set({ subjectType: 'staff' }).where(eq(s.authTokens.id, link.id));
      expect(await processJob(processor(), job)).toEqual({ sent: false, skipped: 'link_not_usable' });
      expect(mailbox(t).sent).toEqual([]);
      expect(account.id).toBe(job.data.aggregateId);
    });

    it('sends nothing for a link that has expired, and does not rotate it', async () => {
      const { job, link, db } = await begin();
      clock.advance(HOUR + 1000);
      expect(await processJob(processor(), job)).toEqual({ sent: false, skipped: 'link_not_usable' });
      expect(mailbox(t).sent).toEqual([]);
      const [after] = await db.select().from(s.authTokens).where(eq(s.authTokens.id, link.id));
      expect(after!.tokenHash).toBe(link.tokenHash);
    });

    for (const how of ['switched off', 'missing'] as const) {
      it(`sends the shipped text, with a link that works, when the template is ${how} (decision 047)`, async () => {
        const { account, job, db } = await begin();
        const ofEvent = eq(s.notificationTemplates.event, event);
        if (how === 'switched off') await db.update(s.notificationTemplates).set({ isActive: false }).where(ofEvent);
        else await db.delete(s.notificationTemplates).where(ofEvent);
        expect(await processJob(processor(), job)).toEqual({ sent: true });

        expect(mailbox(t).sent).toHaveLength(1);
        expect(mailbox(t).sent[0]).toMatchObject({ to: account.email, subject: flow.subject });
        expect(await rowsOfEvent(db)).toMatchObject([{ status: 'sent', event }]);
        const delivered = tokenIn(mailbox(t).sent[0]!.text);
        // The warning names the reason and holds neither the text nor the link.
        const warning = logSink.lines.filter((line) => String(line.msg).includes('the shipped text is used')).at(-1);
        expect(String(warning?.msg)).toContain(how === 'missing' ? 'no stored template' : 'switched off');
        expect(JSON.stringify(logSink.lines)).not.toContain(delivered);
        expect(await linkWorks(delivered, flow.kind)).toBe(account.id);
      });
    }

    it('finishes the row of an earlier attempt as failed when a retry finds the account suspended', async () => {
      const { account, job, db } = await begin();
      mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
      await expectRejection(processJob(processor(), job, 0), 'The mail server is busy.');
      await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, account.id));
      expect(await processJob(processor(), job, 1)).toEqual({ sent: false, skipped: 'account_not_active' });
      expect(await rowsOfEvent(db)).toMatchObject([{ status: 'failed', error: 'account_not_active' }]);
      expect(mailbox(t).sent).toEqual([]);
    });
  });
}

describe('the account row after the mails', () => {
  it('keeps its rank and status: a mail never changes the account', async () => {
    const { account } = await queue('retail', 'magic_link', 'Daniel Whitmore');
    const before = await accountRow(account.id);
    await processJob(t.app.get(MagicLinkMailProcessor), await jobOf('customer.magic_link', account.id));
    expect(await accountRow(account.id)).toMatchObject({ status: before.status, groupId: before.groupId });
    expect(accountLinks().map((link) => [link.kind, link.accountId])).toEqual([['magic_link', account.id]]);
  });
});
