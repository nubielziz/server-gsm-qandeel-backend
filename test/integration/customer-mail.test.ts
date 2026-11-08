// Integration tests of the customer mails (feature 14b, decision 033): the four outbox event types are registered with the notifications
// queue and each has one named processor; for each kind the job rotates the link's token, sends one email through the notification
// delivery whose link works, never holds the clear token in the database or the log, sends once when it runs twice, and sends nothing for
// a customer that is not active, a link that was used, voided or has expired, or a template that is missing or switched off.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
import { DiscoveryService, ModulesContainer } from '@nestjs/core';
import { and, asc, eq } from 'drizzle-orm';
import { TokenService } from '../../src/infra/crypto';
import { DbService, schema as s } from '../../src/infra/db';
import { UnrecoverableError } from '../../src/infra/queues';
import { buildProcessorTable, findQueueProcessors } from '../../src/infra/queues/queue-processor';
import { CUSTOMER_MAIL_EVENTS, type CustomerMailKind } from '../../src/modules/customers';
import { PURPOSE_OF_KIND } from '../../src/modules/customers/application/mail/customer-mail-jobs';
import {
  CustomerEmailVerificationMailProcessor,
  CustomerInvitedMailProcessor,
  CustomerPasswordResetMailProcessor,
  MagicLinkMailProcessor,
} from '../../src/modules/customers/jobs/customer-mail.processors';
import { CustomerAuthTokens } from '../../src/modules/identity';
import {
  CUSTOMER_MAIL_EVENT_KEYS,
  DeliveryError,
  OutboxRouteRegistry,
  type OutboxJobData,
} from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, signInStaff } from '../support/auth';
import { HOUR, TestClock } from '../support/clock';
import { insertTaxRates } from '../support/customers';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { logSink } from '../support/log-sink';
import { mailbox, seedDefaultTemplates, tokenIn } from '../support/notifications';
import { expectRejection } from '../support/rejection';
import {
  STORE_ORIGIN,
  StoreClient,
  captureCustomerLinks,
  clearStoreRateLimits,
  customerLinks,
  customerRow,
  makeCustomer,
} from '../support/store';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: STORE_ORIGIN }, clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  await resetDb();
  // The invitation test adds a customer in Germany: the storefront sells there when it has a current tax rate.
  await insertTaxRates((await testDb()).db, ['DE']);
  // resetDb empties `notification_templates`: the mails need the templates the migrations ship.
  await seedDefaultTemplates((await testDb()).db);
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  logSink.clear();
  mailbox(t).reset();
  captureCustomerLinks(t);
});
afterEach(() => mock.restore());

const store = () => new StoreClient(t);
const NEW_PASSWORD = 'a-much-longer-passphrase';

/** The BullMQ job the relay would make from the stored outbox event of this type for this customer. */
async function jobOf(type: string, customerId: number): Promise<{ data: OutboxJobData }> {
  const { db } = await testDb();
  const [event] = await db
    .select()
    .from(s.outboxEvents)
    .where(and(eq(s.outboxEvents.type, type), eq(s.outboxEvents.aggregateId, customerId)))
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

/** Who a flow made the mail for. */
interface Started {
  readonly customerId: number;
  readonly email: string;
  readonly name: string;
}

/** One of the four mails, from the request that writes its event to the use of its link. */
interface Flow {
  readonly kind: CustomerMailKind;
  readonly processor: new (...args: never[]) => { process(job: never): Promise<unknown> };
  readonly subject: string;
  /** The path of the storefront page the link opens. */
  readonly path: string;
  /** Makes the request that writes the event; returns the customer that gets the mail. */
  start(): Promise<Started>;
  /** Uses a link (the delivered one, or the placeholder of the request) and checks what it does. */
  use(token: string, who: Started): Promise<void>;
}

/** Staff create an account in link mode, or change an account's email: the two flows that start with a staff request. */
async function staffRequest(method: 'POST' | 'PATCH', url: string, payload: unknown) {
  const staff = await signInStaff(t, ['customers:create', 'customers:update', 'customers:password']);
  return t.app.inject({ method, url, headers: staff.session.mutationHeaders, payload: payload as never });
}

const setPasswordAndSignIn = async (token: string, who: Started) => {
  expect((await store().setPassword(token, NEW_PASSWORD)).statusCode).toBe(204);
  expect((await store().login(who.email, NEW_PASSWORD)).statusCode).toBe(200);
};

const FLOWS: readonly Flow[] = [
  {
    kind: 'magic_link',
    processor: MagicLinkMailProcessor,
    subject: 'Your sign-in link',
    path: '/sign-in',
    async start() {
      // An Arabic-speaking customer gets the English template: it is the fallback language.
      const customer = await makeCustomer(t, {
        name: 'Daniel Whitmore',
        email: 'daniel.whitmore@example.com',
        locale: 'ar',
      });
      expect((await store().magicLink(customer.email)).statusCode).toBe(204);
      return { customerId: customer.id, email: customer.email, name: 'Daniel Whitmore' };
    },
    async use(token) {
      const client = store();
      expect((await client.verify(token)).statusCode).toBe(200);
      expect((await client.me()).statusCode).toBe(200);
    },
  },
  {
    kind: 'password_reset',
    processor: CustomerPasswordResetMailProcessor,
    subject: 'Reset your password',
    path: '/set-password',
    async start() {
      const customer = await makeCustomer(t, { name: 'Maya Cohen', email: 'maya.cohen@example.com' });
      expect((await store().forgot(customer.email)).statusCode).toBe(204);
      return { customerId: customer.id, email: customer.email, name: 'Maya Cohen' };
    },
    use: (token, who) => setPasswordAndSignIn(token, who),
  },
  {
    kind: 'invited',
    processor: CustomerInvitedMailProcessor,
    subject: 'Your GSM account is ready',
    path: '/set-password',
    async start() {
      const created = await staffRequest('POST', '/admin/customers', {
        name: 'Lukas Brandt',
        email: 'lukas@example.com',
        country: 'DE',
        locale: 'en',
        password: { mode: 'reset_link' },
      });
      expect(created.statusCode).toBe(201);
      return { customerId: created.json<{ id: number }>().id, email: 'lukas@example.com', name: 'Lukas Brandt' };
    },
    use: (token, who) => setPasswordAndSignIn(token, who),
  },
  {
    kind: 'email_verification',
    processor: CustomerEmailVerificationMailProcessor,
    subject: 'Confirm your email address',
    path: '/verify-email',
    async start() {
      const account = await makeCustomer(t, {
        name: 'Sara Haddad',
        email: 'sara.old@example.com',
        emailVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
      });
      const changed = await staffRequest('PATCH', `/admin/customers/${account.id}`, { email: 'sara.new@example.com' });
      expect(changed.statusCode).toBe(200);
      return { customerId: account.id, email: 'sara.new@example.com', name: 'Sara Haddad' };
    },
    async use(token, who) {
      expect((await store().verify(token)).statusCode).toBe(200);
      expect((await customerRow(who.customerId)).emailVerifiedAt).not.toBeNull();
    },
  },
];

/** The placeholder token of the request: the newest link recorded for the customer. */
const placeholderOf = (who: Started): string =>
  customerLinks().findLast((link) => link.customerId === who.customerId)!.token;

describe('the customer mail events', () => {
  it('are registered with the notifications queue, and each has one named processor in the worker table', () => {
    const routes = t.app.get(OutboxRouteRegistry);
    for (const type of Object.values(CUSTOMER_MAIL_EVENTS)) {
      expect(routes.get(type), type).toMatchObject({ type, queue: 'notifications' });
    }
    const table = buildProcessorTable(findQueueProcessors(new DiscoveryService(t.app.get(ModulesContainer))));
    const named = [...(table.get('notifications')?.byName.keys() ?? [])]
      .filter((name) => name.startsWith('customer.'))
      .sort();
    expect(named).toEqual(Object.values(CUSTOMER_MAIL_EVENTS).sort());
    expect(table.get('notifications')?.catchAll).toBeUndefined();
    // The platform's registry keeps its own copy of the four keys: the two must never drift apart.
    expect([...CUSTOMER_MAIL_EVENT_KEYS].sort()).toEqual(Object.values(CUSTOMER_MAIL_EVENTS).sort());
  });

  it('fail a job that lost its token id for good', async () => {
    const [flow] = FLOWS;
    const who = await flow!.start();
    const job = await jobOf(CUSTOMER_MAIL_EVENTS[flow!.kind], who.customerId);
    const broken = { data: { ...job.data, payload: {} } };
    await expectRejection(processJob(t.app.get(flow!.processor), broken), UnrecoverableError);
    expect(mailbox(t).sent).toEqual([]);
  });

  it('never write a link or a token to the log, in a request or in a job, whatever the environment', async () => {
    const log = spyOn(Logger.prototype, 'log');
    const warn = spyOn(Logger.prototype, 'warn');
    for (const flow of FLOWS) {
      const who = await flow.start();
      await processJob(t.app.get(flow.processor), await jobOf(CUSTOMER_MAIL_EVENTS[flow.kind], who.customerId));
      const text = [...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0])).join('\n');
      expect(text).not.toContain(placeholderOf(who));
      expect(text).not.toContain(tokenIn(mailbox(t).sent.at(-1)!.text));
    }
    const text = [...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0])).join('\n');
    expect(text).not.toContain('DEVELOPMENT ONLY');
    expect(text).not.toContain('token=');
  });
});

for (const flow of FLOWS) {
  describe(`customer.${flow.kind}`, () => {
    const event = CUSTOMER_MAIL_EVENTS[flow.kind];
    const processor = () => t.app.get(flow.processor);

    /** Starts the flow and returns the customer, the job and the row of the link before the job rotates it. */
    async function begin() {
      const who = await flow.start();
      const { db } = await testDb();
      const [link] = await db.select().from(s.authTokens).where(eq(s.authTokens.subjectId, who.customerId));
      return { who, job: await jobOf(event, who.customerId), link: link!, db };
    }

    it('sends exactly one email, with a link that works, and the request’s placeholder is dead', async () => {
      const { who, job, link, db } = await begin();
      const placeholder = placeholderOf(who);
      expect(await processJob(processor(), job)).toEqual({ sent: true });

      // One mail to the customer's address, in English, with the name, the page's link and the expiry in the text.
      expect(mailbox(t).sent).toHaveLength(1);
      const [mail] = mailbox(t).sent;
      expect(mail).toMatchObject({ to: who.email, subject: flow.subject });
      expect(mail!.text).toContain(who.name);
      expect(mail!.text).toContain('2026-11-07 11:00 UTC');
      expect(mail!.text).toContain(`${t.config.http.storeBaseUrl}${flow.path}?token=`);
      const delivered = tokenIn(mail!.text);
      expect(delivered).not.toBe(placeholder);

      // The same row (id, expiry) now holds the hash of the delivered token only.
      const [after] = await db.select().from(s.authTokens).where(eq(s.authTokens.id, link.id));
      expect(after).toMatchObject({ expiresAt: link.expiresAt, usedAt: null });
      expect(after!.tokenHash).toBe(t.app.get(TokenService).hash(delivered));

      // One `notifications` row logs the mail: customer, attempts and the event's dedupe key, no link.
      expect(await db.select().from(s.notifications)).toMatchObject([
        {
          recipientType: 'customer',
          recipientId: who.customerId,
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

      // The delivered link works (and the placeholder does not: it was replaced).
      await flow.use(delivered, who);
    });

    it('sends once when the job runs twice, and the link that arrived still works', async () => {
      const { who, job } = await begin();
      expect(await processJob(processor(), job)).toEqual({ sent: true });
      const delivered = tokenIn(mailbox(t).sent[0]!.text);

      expect(await processJob(processor(), job, 1)).toEqual({ sent: false, skipped: 'already_sent' });
      expect(mailbox(t).sent).toHaveLength(1);
      const { db } = await testDb();
      expect(await db.select().from(s.notifications)).toHaveLength(1);
      await flow.use(delivered, who);
    });

    it('retries a mail server that fails: one mail in the end, one row, and the last link works', async () => {
      const { who, job } = await begin();
      mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
      await expectRejection(processJob(processor(), job, 0), 'The mail server is busy.');
      const { db } = await testDb();
      expect(await db.select().from(s.notifications)).toMatchObject([{ status: 'queued', attempts: 1 }]);

      expect(await processJob(processor(), job, 1)).toEqual({ sent: true });
      expect(mailbox(t).sent).toHaveLength(1);
      expect(await db.select().from(s.notifications)).toMatchObject([{ status: 'sent', attempts: 2 }]);
      await flow.use(tokenIn(mailbox(t).sent[0]!.text), who);
    });

    for (const [status, skipped] of [
      ['suspended', 'customer_not_active'],
      ['blocked', 'customer_not_active'],
      ['anonymized', 'customer_gone'],
    ] as const) {
      it(`sends nothing to a ${status} customer and leaves the link as it is`, async () => {
        const { who, job, link, db } = await begin();
        await db.update(s.customers).set({ status }).where(eq(s.customers.id, who.customerId));
        expect(await processJob(processor(), job)).toEqual({ sent: false, skipped });
        expect(mailbox(t).sent).toEqual([]);
        expect(await db.select().from(s.notifications)).toEqual([]);
        const [after] = await db.select().from(s.authTokens).where(eq(s.authTokens.id, link.id));
        expect(after!.tokenHash).toBe(link.tokenHash);
      });
    }

    it('sends nothing to a customer that is gone', async () => {
      const { who, job, db } = await begin();
      await db.delete(s.authTokens);
      await db.delete(s.customerCredentials);
      await db.delete(s.customers).where(eq(s.customers.id, who.customerId));
      expect(await processJob(processor(), job)).toEqual({ sent: false, skipped: 'customer_gone' });
      expect(mailbox(t).sent).toEqual([]);
    });

    it('sends nothing for a link that was used', async () => {
      const { who, job } = await begin();
      await flow.use(placeholderOf(who), who);
      expect(await processJob(processor(), job)).toEqual({ sent: false, skipped: 'link_not_usable' });
      expect(mailbox(t).sent).toEqual([]);
    });

    it('sends nothing for a link that was voided', async () => {
      const { who, job } = await begin();
      await t.app
        .get(DbService)
        .runInTransaction((work) =>
          t.app.get(CustomerAuthTokens).voidOpen(work, who.customerId, [PURPOSE_OF_KIND[flow.kind]]),
        );
      expect(await processJob(processor(), job)).toEqual({ sent: false, skipped: 'link_not_usable' });
      expect(mailbox(t).sent).toEqual([]);
    });

    it('sends nothing for a link that has expired, and does not rotate it', async () => {
      const { job, link, db } = await begin();
      clock.advance(HOUR + 1000);
      expect(await processJob(processor(), job)).toEqual({ sent: false, skipped: 'link_not_usable' });
      expect(mailbox(t).sent).toEqual([]);
      const [after] = await db.select().from(s.authTokens).where(eq(s.authTokens.id, link.id));
      expect(after!.tokenHash).toBe(link.tokenHash);
    });

    it('sends nothing, and keeps the link as it is, when the template is switched off or missing', async () => {
      const { who, job, link, db } = await begin();
      const ofEvent = eq(s.notificationTemplates.event, event);
      await db.update(s.notificationTemplates).set({ isActive: false }).where(ofEvent);
      expect(await processJob(processor(), job)).toEqual({ sent: false, skipped: 'template_off' });
      await db.delete(s.notificationTemplates).where(ofEvent);
      expect(await processJob(processor(), job)).toEqual({ sent: false, skipped: 'no_template' });

      expect(mailbox(t).sent).toEqual([]);
      expect(await db.select().from(s.notifications)).toEqual([]);
      const [after] = await db.select().from(s.authTokens).where(eq(s.authTokens.id, link.id));
      expect(after!.tokenHash).toBe(link.tokenHash);
      // The link of the request still works: nothing took it away.
      await flow.use(placeholderOf(who), who);
    });

    it('finishes the row of an earlier attempt as failed when a retry finds the customer suspended', async () => {
      const { who, job, db } = await begin();
      mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
      await expectRejection(processJob(processor(), job, 0), 'The mail server is busy.');
      await db.update(s.customers).set({ status: 'suspended' }).where(eq(s.customers.id, who.customerId));
      expect(await processJob(processor(), job, 1)).toEqual({ sent: false, skipped: 'customer_not_active' });
      expect(await db.select().from(s.notifications)).toMatchObject([
        { status: 'failed', error: 'customer_not_active' },
      ]);
      expect(mailbox(t).sent).toEqual([]);
    });
  });
}
