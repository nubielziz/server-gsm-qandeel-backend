// Integration tests of the shop's sign-up with details (decision 079 and its fix round; routes POST /store/v1/auth/sign-up and
// POST /store/v1/auth/sign-up/finish) and of what it changes in the sign-in link (POST /store/v1/auth/magic-link, POST /store/v1/auth/verify),
// through HTTP on the real application and a real Postgres: the form waits beside its own link and is applied only in the browser that sent
// it; anywhere else the account is made with nothing of it and finished by its owner; an address with a login account keeps everything; a
// link no longer makes an account and the note to an unknown address leaves no row; the three mails; the country list; every refusal.
// The search for the password in the logs at trace level is in store-sign-up-secrecy.test.ts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { asc, eq, inArray } from 'drizzle-orm';
import { DbService, schema as s } from '@src/infra/db';
import { JobRunsService } from '@src/modules/health';
import { SessionPurge, SignUpPurgeProcessor } from '@src/modules/identity';
import { AccountMailJobs } from '@src/modules/identity/application/mail/account-mail-jobs';
import { ensureRetailGroup } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { HOUR, TestClock } from '../../support/clock';
import { insertAnyService, insertCustomerOrder, insertStoreCurrencies, insertTaxRates } from '../../support/customers';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { mailbox, sendAllQueued } from '../../support/notifications';
import { freshClientIp } from '../../support/pipeline-routes';
import {
  CUSTOMER_PASSWORD,
  SIGN_UP_PASSWORD,
  STORE_ORIGIN,
  StoreClient,
  captureCustomerLinks,
  clearStoreRateLimits,
  customerLinks,
  customerRow,
  issueOldSignInLink,
  makeCustomer,
  noAccountNotes,
} from '../../support/store';

const clock = new TestClock('2026-11-28T09:00:00.000Z');
let t: TestApp;

/** The asking-browser cookie of the sign-in link (not secure in tests, so without the __Host- prefix). */
const LINK_COOKIE = 'gsm_store_link';

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: STORE_ORIGIN }, clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-28T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  const { db } = await testDb();
  // The retail rank the migrations insert (resetDb empties its table), the countries the shop sells to and its currencies.
  await ensureRetailGroup(db);
  await insertTaxRates(db, ['GB', 'JO']);
  await insertStoreCurrencies(db);
  captureCustomerLinks(t);
  mailbox(t).reset();
});
afterEach(() => mock.restore());

const store = (ip?: string) => new StoreClient(t, ip ?? freshClientIp());
const problem = (res: { json: () => unknown }) =>
  res.json() as { code: string; detail?: string; errors?: Array<{ field: string; code?: string; message: string }> };

/** The login rows (has_account) and the guest rows of an email. */
async function rowsOf(email: string) {
  const { db } = await testDb();
  const rows = await db.select().from(s.clients).where(eq(s.clients.email, email)).orderBy(asc(s.clients.id));
  return { logins: rows.filter((row) => row.hasAccount), guests: rows.filter((row) => !row.hasAccount) };
}

/** Every waiting sign-up row. */
async function waitingRows() {
  const { db } = await testDb();
  return db.select().from(s.accountSignups).orderBy(asc(s.accountSignups.id));
}

/** The types of the outbox events of the account link mails, oldest first. */
async function linkMailTypes(): Promise<string[]> {
  const { db } = await testDb();
  const rows = await db
    .select({ type: s.outboxEvents.type })
    .from(s.outboxEvents)
    .where(inArray(s.outboxEvents.type, ['customer.magic_link', 'customer.sign_up_link', 'customer.sign_up_existing']))
    .orderBy(asc(s.outboxEvents.id));
  return rows.map((row) => row.type);
}

/** Runs the account link mails the way the worker would (the job rotates each link and sends it), oldest first. */
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

/** The notices of one event written for an account, oldest first: the change each one names. */
async function noticesOf(accountId: number, event: string): Promise<string[]> {
  const { db } = await testDb();
  const rows = await db
    .select({ recipientId: s.notifications.recipientId, payload: s.notifications.payload })
    .from(s.notifications)
    .where(eq(s.notifications.event, event))
    .orderBy(asc(s.notifications.id));
  return rows
    .filter((row) => row.recipientId === accountId)
    .map((row) => String((row.payload as { variables?: Record<string, string> }).variables?.['change']));
}

/** A browser that signed up for the email, and the link the sign-up issued. */
async function signedUp(email: string, form: Record<string, string> = {}) {
  const browser = store();
  expect((await browser.signUp({ email, ...form })).statusCode).toBe(204);
  const link = customerLinks().at(-1)!;
  return { browser, link };
}

describe('POST /store/v1/auth/sign-up', () => {
  it('answers 204, mails one link, makes no account yet and keeps only the hash of the password beside the link', async () => {
    const client = store();
    const res = await client.signUp({ email: 'New.Buyer@Example.com' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.headers['cache-control']).toBe('no-store');
    // The asking-browser cookie of the sign-in link, for as long as the link lives.
    const cookie = res.cookies.find((one) => one.name.endsWith(LINK_COOKIE));
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 3600 });

    const links = customerLinks();
    expect(links.map((link) => link.kind)).toEqual(['magic_link']);
    const { logins, guests } = await rowsOf('new.buyer@example.com');
    expect(logins).toEqual([]);
    expect(guests).toHaveLength(1);
    expect(links[0]!.accountId).toBe(guests[0]!.id);

    const { db } = await testDb();
    const [token] = await db.select().from(s.authTokens);
    const waiting = await waitingRows();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      authTokenId: token!.id,
      firstName: 'Daniel',
      lastName: 'Whitmore',
      country: 'GB',
      phone: '+447700900123',
    });
    expect(waiting[0]!.passwordHash).toStartWith('$argon2id$');
    expect(JSON.stringify(waiting)).not.toContain(SIGN_UP_PASSWORD);
    // The mail "finish creating your account" (the review's S3), not the plain sign-in link.
    expect(await linkMailTypes()).toEqual(['customer.sign_up_link']);
    expect(JSON.stringify(await db.select().from(s.outboxEvents))).not.toContain(SIGN_UP_PASSWORD);
  });

  it('mails "Finish creating your account" to a new address and "You already have an account" to a login account (S3)', async () => {
    const holder = await makeCustomer(t, { name: 'Original Name' });
    await store().signUp({ email: 'fresh@example.com' });
    await store().signUp({ email: holder.email });
    await sendLinkMails();
    const sent = mailbox(t).sent;
    expect(sent.map((mail) => [mail.to, mail.subject])).toEqual([
      ['fresh@example.com', 'Finish creating your account'],
      [holder.email, 'You already have an account'],
    ]);
    expect(sent[0]!.text).toContain(
      'If you did not ask for this, ignore this email: no account is made until the link is opened.',
    );
    expect(sent[0]!.text).toMatch(/http:\/\/localhost:5175\/sign-in\?token=\S+/);
    expect(sent[1]!.text).toContain('You already have an account. Nothing was changed.');
    expect(sent[1]!.text).toMatch(/http:\/\/localhost:5175\/sign-in\?token=\S+/);
    for (const mail of sent) expect(JSON.stringify(mail)).not.toContain(SIGN_UP_PASSWORD);
    // The link of the mail is the one that works: it opens the account it was mailed for.
    const token = /token=(\S+)/.exec(sent[1]!.text)![1]!;
    const opened = await store().verify(decodeURIComponent(token));
    expect(opened.json()).toMatchObject({ id: holder.id, name: 'Original Name' });
  });

  it('makes the account with the details and a working password when the link is opened in the browser that sent the form', async () => {
    const { browser, link } = await signedUp('new@example.com');
    const verified = await browser.verify(link.token);
    expect(verified.statusCode).toBe(200);
    const answer = verified.json<Record<string, unknown>>();
    expect(answer).toMatchObject({
      email: 'new@example.com',
      name: 'Daniel Whitmore',
      country: 'GB',
      phone: '+447700900123',
      hasPassword: true,
      requestedHere: true,
      passwordSet: true,
      next: 'done',
    });
    expect('pendingDetails' in answer).toBe(false);
    const { logins, guests } = await rowsOf('new@example.com');
    expect(guests).toEqual([]);
    expect(logins).toHaveLength(1);
    expect(logins[0]).toMatchObject({
      id: link.accountId,
      name: 'Daniel Whitmore',
      country: 'GB',
      currency: 'GBP',
      phone: '+447700900123',
      mustChangePassword: false,
      passwordSetByStaff: false,
      passwordChangedAt: new Date('2026-11-28T09:00:00.000Z'),
      emailVerifiedAt: new Date('2026-11-28T09:00:00.000Z'),
    });
    // The session this exchange opened stays, and the details are gone with the link.
    expect((await browser.me()).statusCode).toBe(200);
    expect(await waitingRows()).toEqual([]);
    // The password of the form signs in.
    expect((await store().login('new@example.com', SIGN_UP_PASSWORD)).statusCode).toBe(200);
  });

  describe('opened in another browser (S6): the account is made and signed in with nothing of the form', () => {
    const cases: Array<[string, (browser: StoreClient) => Promise<void> | void]> = [
      ['a browser without the asking-browser cookie', () => undefined],
      [
        'a browser holding its own valid asking-browser cookie from another request',
        async (browser) => {
          expect((await browser.magicLink('somebody.else@example.com')).statusCode).toBe(204);
          expect(browser.cookie(LINK_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
        },
      ],
      [
        'a browser holding a forged cookie of the right shape',
        (browser) => browser.setCookie(LINK_COOKIE, 'Q'.repeat(43)),
      ],
    ];

    it.each(cases)('%s', async (_name, prepare) => {
      const { browser: sender, link } = await signedUp('new@example.com');
      const elsewhere = store();
      await prepare(elsewhere);
      expect(elsewhere.cookie(LINK_COOKIE)).not.toBe(sender.cookie(LINK_COOKIE));
      const verified = await elsewhere.verify(link.token);
      expect(verified.statusCode).toBe(200);
      const answer = verified.json<Record<string, unknown>>();
      expect(answer).toMatchObject({
        id: link.accountId,
        name: '',
        country: '',
        phone: '',
        hasPassword: false,
        requestedHere: false,
        passwordSet: false,
        // The details as typed, for the person who proved the mailbox to confirm: never the password.
        pendingDetails: { firstName: 'Daniel', lastName: 'Whitmore', country: 'GB', phone: '+447700900123' },
      });
      expect(JSON.stringify(answer)).not.toContain(SIGN_UP_PASSWORD);
      expect(JSON.stringify(answer)).not.toContain('argon2id');
      expect(await customerRow(link.accountId)).toMatchObject({
        hasAccount: true,
        passwordHash: null,
        passwordChangedAt: null,
        name: '',
        country: '',
        phone: '',
      });
      // The waiting hash is discarded, and the stranger who sent the form cannot sign in with its password.
      expect(await waitingRows()).toEqual([]);
      expect((await store().login('new@example.com', SIGN_UP_PASSWORD)).statusCode).toBe(401);
      expect((await elsewhere.me()).statusCode).toBe(200);
    });
  });

  it('changes nothing of an account that holds the email: its ordinary link, no details, its own password', async () => {
    const holder = await makeCustomer(t, { name: 'Original Name', phone: '+962790000000', country: 'JO' });
    const before = await customerRow(holder.id);
    const client = store();
    expect((await client.signUp({ email: holder.email, firstName: 'Mallory' })).statusCode).toBe(204);
    expect(customerLinks()).toEqual([expect.objectContaining({ kind: 'magic_link', accountId: holder.id })]);
    expect(await linkMailTypes()).toEqual(['customer.sign_up_existing']);
    expect(await waitingRows()).toEqual([]);
    expect((await rowsOf(holder.email)).guests).toEqual([]);

    // Opened even in the browser that sent the form, it is a plain sign-in: neither key, nothing applied.
    const verified = await client.verify(customerLinks()[0]!.token);
    expect(verified.statusCode).toBe(200);
    expect('passwordSet' in verified.json<object>()).toBe(false);
    expect('pendingDetails' in verified.json<object>()).toBe(false);
    const after = await customerRow(holder.id);
    expect(after).toMatchObject({
      name: 'Original Name',
      phone: '+962790000000',
      country: 'JO',
      passwordHash: before.passwordHash,
      passwordChangedAt: before.passwordChangedAt,
    });
    expect((await store().login(holder.email, CUSTOMER_PASSWORD)).statusCode).toBe(200);
    expect((await store().login(holder.email, SIGN_UP_PASSWORD)).statusCode).toBe(401);
  });

  it('turns the guest row of a checkout into the account, which keeps its orders', async () => {
    const guest = await makeCustomer(t, { guest: true, email: 'buyer@example.com' });
    const { db } = await testDb();
    const orderId = await insertCustomerOrder(db, await insertAnyService(db), guest.id);
    const { browser, link } = await signedUp('buyer@example.com');
    expect(link.accountId).toBe(guest.id);
    const verified = await browser.verify(link.token);
    expect(verified.json()).toMatchObject({ id: guest.id, passwordSet: true, name: 'Daniel Whitmore' });
    expect(await customerRow(guest.id)).toMatchObject({ hasAccount: true });
    const orders = await browser.orders();
    expect(orders.statusCode).toBe(200);
    expect(JSON.stringify(orders.json())).toContain(String(orderId));
  });

  it('keeps each form beside its own link (B2): the link opened first applies its own form, and the exchange ends every other', async () => {
    const first = await signedUp('twice@example.com', { lastName: 'First' });
    const second = await signedUp('twice@example.com', { lastName: 'Second', phone: '+962 79 000 1111' });
    // Two browsers, two links, two waiting forms of one guest row: the newer sign-up deleted nothing.
    expect(first.link.accountId).toBe(second.link.accountId);
    expect((await waitingRows()).map((row) => row.lastName)).toEqual(['First', 'Second']);

    // The OLDER link, in the browser that sent it, applies the older form: not the newer one, and not nothing.
    const verified = await first.browser.verify(first.link.token);
    expect(verified.json()).toMatchObject({ name: 'Daniel First', phone: '+447700900123', passwordSet: true });
    // Every waiting form of the address went with the exchange, and the newer link was voided by it.
    expect(await waitingRows()).toEqual([]);
    expect((await second.browser.verify(second.link.token)).statusCode).toBe(410);
    expect((await store().login('twice@example.com', SIGN_UP_PASSWORD)).statusCode).toBe(200);
  });

  it('deletes the forms of the links the exchange voids even when a plain sign-in link is opened (S5)', async () => {
    const guest = await makeCustomer(t, { guest: true, email: 'mixed@example.com' });
    await signedUp('mixed@example.com');
    const oldToken = await issueOldSignInLink(t, guest.id);
    expect(await waitingRows()).toHaveLength(1);
    const plain = await store().verify(oldToken);
    expect(plain.statusCode).toBe(200);
    expect('passwordSet' in plain.json<object>()).toBe(false);
    expect(await waitingRows()).toEqual([]);
  });

  it('refuses each field on its own with 422, and changes nothing', async () => {
    const cases: Array<[Record<string, unknown>, string, string?]> = [
      [{ email: 'not-an-email' }, 'email'],
      [{ firstName: '   ' }, 'firstName'],
      [{ lastName: 'x'.repeat(61) }, 'lastName'],
      [{ lastName: 'Whit\nmore' }, 'lastName'],
      // The review's S4: invisible direction marks, and two names that together pass the account name's 120 characters.
      [{ firstName: 'Dan‮iel' }, 'firstName'],
      [{ lastName: 'Whit⁧more' }, 'lastName'],
      [{ firstName: 'x'.repeat(60), lastName: 'y'.repeat(60) }, 'lastName'],
      [{ phone: '12-34' }, 'phone'],
      [{ phone: '+44 7700 900123 ext 9' }, 'phone'],
      [{ phone: '+44\t7700900123' }, 'phone'],
      [{ phone: '+44‎7700900123' }, 'phone'],
      [{ country: 'GBR' }, 'country'],
      [{ country: 'FR' }, 'country', 'unsupported'],
      [{ password: 'short' }, 'password', 'WEAK_PASSWORD'],
      [{ password: 'daniel-is-my-name' }, 'password', 'WEAK_PASSWORD'],
    ];
    for (const [change, field, code] of cases) {
      const res = await store().signUp({ email: 'refused@example.com', ...change });
      expect(res.statusCode, JSON.stringify(change)).toBe(422);
      const body = problem(res);
      expect(
        body.errors?.map((error) => error.field),
        JSON.stringify(change),
      ).toEqual([field]);
      if (code !== undefined) expect(body.errors?.[0]?.code).toBe(code);
    }
    const weak = problem(await store().signUp({ email: 'refused@example.com', password: 'daniel-is-my-name' }));
    expect(weak).toMatchObject({ code: 'WEAK_PASSWORD' });
    expect(weak.errors?.[0]?.message).toBe('Do not use your name in your password.');
    const missing = await store().call('POST', '/store/v1/auth/sign-up', { email: 'refused@example.com' });
    expect(missing.statusCode).toBe(422);
    expect(
      problem(missing)
        .errors?.map((error) => error.field)
        .sort(),
    ).toEqual(['country', 'firstName', 'lastName', 'password', 'phone']);
    expect(customerLinks()).toEqual([]);
    expect(await waitingRows()).toEqual([]);
    expect((await rowsOf('refused@example.com')).guests).toEqual([]);
  });

  it('accepts any listed country while the shop has no tax window in force, and refuses a code of no country (B1)', async () => {
    const { db } = await testDb();
    await db.delete(s.taxRates);
    for (const country of ['ZZ', 'UK', 'EU']) {
      const res = await store().signUp({ email: 'country@example.com', country });
      expect(res.statusCode, country).toBe(422);
      expect(problem(res).errors?.[0], country).toMatchObject({ field: 'country', code: 'unsupported' });
    }
    expect(customerLinks()).toEqual([]);
    const { browser, link } = await signedUp('country@example.com', { country: 'fr' });
    const verified = await browser.verify(link.token);
    expect(verified.json()).toMatchObject({ country: 'FR', passwordSet: true });
    // The profile edit of the account follows the same list (PATCH /store/v1/me).
    expect((await browser.updateMe({ country: 'ZZ' })).statusCode).toBe(422);
    const moved = await browser.updateMe({ country: 'XK' });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ country: 'XK' });
  });

  it('needs the anti-bot token', async () => {
    for (const turnstile of [false, 'wrong-token'] as const) {
      const res = await store().signUp({ email: 'bot@example.com' }, { turnstile });
      expect(res.statusCode).toBe(403);
      expect(problem(res).code).toBe('TURNSTILE_FAILED');
    }
    expect(customerLinks()).toEqual([]);
    expect(await waitingRows()).toEqual([]);
  });

  it('shares the budget of the sign-in link per email and network: the sixth request is 429', async () => {
    const ip = freshClientIp();
    for (let i = 0; i < 3; i++) expect((await store(ip).magicLink('limit@example.com')).statusCode).toBe(204);
    for (let i = 0; i < 2; i++) expect((await store(ip).signUp({ email: 'limit@example.com' })).statusCode).toBe(204);
    const sixth = await store(ip).signUp({ email: 'limit@example.com' });
    expect(sixth.statusCode).toBe(429);
    expect(problem(sixth).code).toBe('RATE_LIMITED');
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Another network is not refused.
    expect((await store().signUp({ email: 'limit@example.com' })).statusCode).toBe(204);
  });

  it('removes the forms of lapsed links every 15 minutes (S5), records the run, and the daily purge and a deleted link still do too', async () => {
    await store().signUp({ email: 'late@example.com' });
    await store().signUp({ email: 'voided@example.com' });
    await store().signUp({ email: 'other@example.com' });
    expect(await waitingRows()).toHaveLength(3);
    const { db } = await testDb();
    const tokens = await db.select().from(s.authTokens).orderBy(asc(s.authTokens.id));
    // The job of the worker, built on the app's database and clock; its runs are recorded in job_runs.
    const processor = new SignUpPurgeProcessor(
      new SessionPurge(t.app.get(DbService), clock),
      t.app.get(JobRunsService),
    );
    expect(await processor.process({ data: {} } as never)).toEqual({ deleted: 0 });
    // A link voided by another flow keeps its form until the next run.
    await db.update(s.authTokens).set({ usedAt: clock.now() }).where(eq(s.authTokens.id, tokens[1]!.id));
    expect(await processor.process({ data: {} } as never)).toEqual({ deleted: 1 });
    const runs = await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, 'sign_up_purge'));
    expect(runs.map((run) => [run.trigger, run.status, run.processed])).toEqual([
      ['schedule', 'succeeded', 0],
      ['schedule', 'succeeded', 1],
    ]);
    // A deleted link takes its form with it.
    await db.delete(s.authTokens).where(eq(s.authTokens.id, tokens[0]!.id));
    expect(await waitingRows()).toHaveLength(1);
    // Past its hour the link cannot be opened, and the daily purge deletes its form too.
    clock.advance(HOUR + 1000);
    await new SessionPurge(t.app.get(DbService), clock).purge();
    expect(await waitingRows()).toEqual([]);
  });
});

describe('POST /store/v1/auth/sign-up/finish', () => {
  /** A sign-up whose link was opened in another browser: that browser is signed in to an account with nothing of the form. */
  async function openedElsewhere(email = 'phone@example.com') {
    const { link } = await signedUp(email);
    const elsewhere = store();
    expect((await elsewhere.verify(link.token)).json()).toMatchObject({ passwordSet: false });
    return { elsewhere, accountId: link.accountId };
  }

  it('sets the details and the password of the account that the mailbox owner opened, and answers the account', async () => {
    const { elsewhere, accountId } = await openedElsewhere();
    // A second session of the same account (another link mailed to it, opened elsewhere): the finish ends it.
    const second = store();
    await second.magicLink('phone@example.com');
    expect((await second.verify(customerLinks().at(-1)!.token)).statusCode).toBe(200);

    const res = await elsewhere.finishSignUp({ lastName: 'Corrected', phone: '+962 79 123 4567', country: 'jo' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual((await elsewhere.me()).json());
    expect(res.json()).toMatchObject({
      id: accountId,
      name: 'Daniel Corrected',
      country: 'JO',
      phone: '+962791234567',
      hasPassword: true,
      mustChangePassword: false,
    });
    expect(await customerRow(accountId)).toMatchObject({
      passwordChangedAt: new Date('2026-11-28T09:00:00.000Z'),
      mustChangePassword: false,
    });
    // This session stays; the other session of the account ended, as a password change ends them.
    expect((await elsewhere.me()).statusCode).toBe(200);
    expect((await second.me()).statusCode).toBe(401);
    expect((await store().login('phone@example.com', SIGN_UP_PASSWORD)).statusCode).toBe(200);
    // The address is told that a password was set (the re-review of decision 079) with its own security mail (decision 047), not with the
    // staff notice: the owner of the account made this change, so no text may say that support did.
    expect(await noticesOf(accountId, 'customer.password_set')).toEqual([
      'A password was set for your account just now, when its sign-up was finished.',
    ]);
    expect(await noticesOf(accountId, 'customer.security_notice')).toEqual([]);
    await sendAllQueued(t);
    const notice = mailbox(t).sent.find((mail) => mail.subject === 'A password was set for your account');
    expect(notice?.to).toBe('phone@example.com');
    expect(notice?.text).toContain('Hi Daniel Corrected,');
    expect(notice?.text).toContain('A password was set for your account just now, when its sign-up was finished.');
    expect(notice?.text).toContain(
      'If this was you, there is nothing to do. If it was not you, ask for a sign-in link on the sign-in page, then change the password in your account settings, or contact our support team.',
    );
    expect(notice?.text).not.toContain('support team made this change');
    expect(notice?.text).not.toContain(SIGN_UP_PASSWORD);
    expect(mailbox(t).sent.some((mail) => mail.subject === 'A security change on your account')).toBe(false);
  });

  it('needs a session opened at most an hour ago: an older one is 409 and changes nothing, a new link opens a fresh one', async () => {
    const { elsewhere, accountId } = await openedElsewhere();
    // Just over an hour later; the session itself stays live (an account session idles for 7 days).
    clock.advance(HOUR + 1000);
    const late = await elsewhere.finishSignUp();
    expect(late.statusCode).toBe(409);
    expect(problem(late)).toMatchObject({
      code: 'CONFLICT',
      detail:
        'For your security, finish creating your account within an hour of opening the sign-in link. Ask for a new sign-in link, open it and try again.',
    });
    expect(await customerRow(accountId)).toMatchObject({ name: '', passwordHash: null });
    expect(await noticesOf(accountId, 'customer.password_set')).toEqual([]);
    expect((await elsewhere.me()).statusCode).toBe(200);
    // A new sign-in link proves the mailbox again and opens a young session, which may finish.
    expect((await elsewhere.magicLink('phone@example.com')).statusCode).toBe(204);
    expect((await elsewhere.verify(customerLinks().at(-1)!.token)).statusCode).toBe(200);
    expect((await elsewhere.finishSignUp()).statusCode).toBe(200);
    expect(await customerRow(accountId)).toMatchObject({ name: 'Daniel Whitmore' });
  });

  it('keeps the currency an account chose when it confirms its stored country, and derives it when the country changes', async () => {
    const { db } = await testDb();
    const finish = async (email: string, stored: { country: string; currency: string }) => {
      const guest = await makeCustomer(t, { guest: true, email });
      await db.update(s.clients).set(stored).where(eq(s.clients.id, guest.id));
      const browser = store();
      expect((await browser.verify(await issueOldSignInLink(t, guest.id))).statusCode).toBe(200);
      const res = await browser.finishSignUp({ country: 'gb' });
      expect(res.statusCode).toBe(200);
      return res.json<{ country: string; currency: string }>();
    };
    // As PATCH /store/v1/me: the same country keeps the currency the account chose.
    expect(await finish('same.country@example.com', { country: 'GB', currency: 'USD' })).toMatchObject({
      country: 'GB',
      currency: 'USD',
    });
    // A changed country derives it again.
    expect(await finish('new.country@example.com', { country: 'JO', currency: 'USD' })).toMatchObject({
      country: 'GB',
      currency: 'GBP',
    });
  });

  it('completes an older account made by a link before decision 079, with no details and no password', async () => {
    // No details: no country yet, so the finish gives it the currency of the new country.
    const guest = await makeCustomer(t, { guest: true, email: 'older@example.com', country: '' });
    const browser = store();
    expect((await browser.verify(await issueOldSignInLink(t, guest.id))).json()).toMatchObject({ hasPassword: false });
    const res = await browser.finishSignUp();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Daniel Whitmore', country: 'GB', currency: 'GBP', hasPassword: true });
  });

  it('refuses an account that already has a password (409), and changes nothing', async () => {
    const holder = await makeCustomer(t, { name: 'Has Password' });
    const browser = store();
    expect((await browser.login(holder.email)).statusCode).toBe(200);
    const before = await customerRow(holder.id);
    const res = await browser.finishSignUp();
    expect(res.statusCode).toBe(409);
    expect(problem(res)).toMatchObject({ code: 'CONFLICT' });
    expect(await customerRow(holder.id)).toEqual(before);
    // The account the first link set up has its password too: the finish never replaces one.
    const { browser: sender, link } = await signedUp('applied@example.com');
    await sender.verify(link.token);
    expect((await sender.finishSignUp({ password: 'Another-Secret-77' })).statusCode).toBe(409);
    expect((await store().login('applied@example.com', 'Another-Secret-77')).statusCode).toBe(401);
  });

  it('has the rules of the sign-up: 422 per field, the password policy and the country', async () => {
    const { elsewhere, accountId } = await openedElsewhere();
    const cases: Array<[Record<string, string>, string, string?]> = [
      [{ firstName: '' }, 'firstName'],
      [{ lastName: 'Whit‮more' }, 'lastName'],
      [{ firstName: 'x'.repeat(60), lastName: 'y'.repeat(60) }, 'lastName'],
      [{ phone: '12' }, 'phone'],
      [{ country: 'FR' }, 'country', 'unsupported'],
      [{ password: 'short' }, 'password', 'WEAK_PASSWORD'],
      [{ password: 'phone@example.com-1' }, 'password', 'WEAK_PASSWORD'],
    ];
    for (const [change, field, code] of cases) {
      const res = await elsewhere.finishSignUp(change);
      expect(res.statusCode, JSON.stringify(change)).toBe(422);
      expect(
        problem(res).errors?.map((error) => error.field),
        JSON.stringify(change),
      ).toEqual([field]);
      if (code !== undefined) expect(problem(res).errors?.[0]?.code, JSON.stringify(change)).toBe(code);
    }
    expect(await customerRow(accountId)).toMatchObject({ name: '', passwordHash: null });
  });

  it('needs the session and its CSRF token', async () => {
    expect((await store().finishSignUp()).statusCode).toBe(401);
    const { elsewhere, accountId } = await openedElsewhere();
    const res = await elsewhere.finishSignUp({}, { csrf: false });
    expect(res.statusCode).toBe(403);
    expect(problem(res).code).toBe('CSRF_FAILED');
    expect(await customerRow(accountId)).toMatchObject({ passwordHash: null });
  });

  it('allows five tries per account in 15 minutes: the sixth is 429', async () => {
    const { elsewhere } = await openedElsewhere();
    for (let i = 0; i < 5; i++) expect((await elsewhere.finishSignUp({ country: 'FR' })).statusCode).toBe(422);
    const sixth = await elsewhere.finishSignUp();
    expect(sixth.statusCode).toBe(429);
    expect(problem(sixth).code).toBe('RATE_LIMITED');
  });
});

describe('POST /store/v1/auth/magic-link after decision 079', () => {
  it('leaves no row behind for an unknown address and mails the note, addressed to the address, with the sign-up page', async () => {
    const res = await store().magicLink('nobody@example.com');
    expect(res.statusCode).toBe(204);
    expect(res.cookies.some((one) => one.name.endsWith(LINK_COOKIE))).toBe(true);
    expect(customerLinks()).toEqual([]);
    const { db } = await testDb();
    expect(await db.select().from(s.authTokens)).toEqual([]);
    // No row of clients at all: a stranger cannot plant rows for any address (the review of decision 079).
    expect(await db.select().from(s.clients)).toEqual([]);
    expect(await noAccountNotes()).toEqual(['nobody@example.com']);

    await sendAllQueued(t);
    const [mail] = mailbox(t).sent;
    expect(mail).toMatchObject({ to: 'nobody@example.com', subject: 'No account uses this email address yet' });
    expect(mail!.text).toContain('http://localhost:5175/en/sign-up');
    expect(mail!.text).toContain('no account uses it yet');
    expect(mail!.text).not.toContain('token=');
    expect(await db.select().from(s.clients)).toEqual([]);
  });

  it('mails the note, not a link, to an address only a guest row holds, and leaves the guest row as it was', async () => {
    const guest = await makeCustomer(t, { guest: true });
    const before = await customerRow(guest.id);
    expect((await store().magicLink(guest.email)).statusCode).toBe(204);
    expect(customerLinks()).toEqual([]);
    expect(await noAccountNotes()).toEqual([guest.email]);
    expect(await customerRow(guest.id)).toEqual(before);
  });

  it('sends nothing to an address whose guest row is blocked', async () => {
    await makeCustomer(t, { guest: true, email: 'blocked.guest@example.com', status: 'blocked' });
    expect((await store().magicLink('blocked.guest@example.com')).statusCode).toBe(204);
    expect(await noAccountNotes()).toEqual([]);
  });

  it('still mails a sign-in link to a login account', async () => {
    const holder = await makeCustomer(t);
    expect((await store().magicLink(holder.email)).statusCode).toBe(204);
    expect(customerLinks()).toEqual([expect.objectContaining({ kind: 'magic_link', accountId: holder.id })]);
    expect(await linkMailTypes()).toEqual(['customer.magic_link']);
    expect(await noAccountNotes()).toEqual([]);
  });

  it('counts the notes and the sign-up links of an address against one budget: five mails an hour together (the re-review)', async () => {
    const { db } = await testDb();
    for (let i = 0; i < 3; i++) expect((await store().magicLink('shared@example.com')).statusCode).toBe(204);
    for (let i = 0; i < 2; i++) expect((await store().signUp({ email: 'shared@example.com' })).statusCode).toBe(204);
    expect(await noAccountNotes()).toHaveLength(3);
    expect(await waitingRows()).toHaveLength(2);
    // The sixth mail of the hour sends nothing, a sign-up or a note: the budget is the address's, not the guest row's.
    expect((await store().signUp({ email: 'shared@example.com' })).statusCode).toBe(204);
    expect((await store().magicLink('shared@example.com')).statusCode).toBe(204);
    expect(await waitingRows()).toHaveLength(2);
    expect(await noAccountNotes()).toHaveLength(3);
    expect(await db.select().from(s.authTokens)).toHaveLength(2);
  });

  it('sends nothing at all once the address has spent its mail budget', async () => {
    for (let i = 0; i < 5; i++) await store().magicLink('busy@example.com');
    expect(await noAccountNotes()).toHaveLength(5);
    await store().magicLink('busy@example.com');
    expect(await noAccountNotes()).toHaveLength(5);
  });

  it('keeps an old link working: a link mailed to a guest row before the release still makes the account', async () => {
    const guest = await makeCustomer(t, { guest: true });
    const token = await issueOldSignInLink(t, guest.id);
    const verified = await store().verify(token);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ id: guest.id, hasPassword: false });
    expect('passwordSet' in verified.json<object>()).toBe(false);
    expect(await customerRow(guest.id)).toMatchObject({ hasAccount: true });
  });
});
