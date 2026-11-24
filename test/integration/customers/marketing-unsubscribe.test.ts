// Integration tests of the marketing unsubscribe link (feature 23, plan sections 9.6 and 10.5, S10): a marketing email to a customer carries
// the footer and the one-click headers, and `POST /store/v1/marketing/unsubscribe/:token` (public, no CSRF, no anti-bot token) switches
// marketing off with a consent record, idempotently, for a form body and for none, and answers 410 for a bad token.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { APP_CONFIG } from '@src/config';
import { TokenService } from '@src/infra/crypto';
import { type Database, schema as s } from '@src/infra/db';
import { QueuesService } from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import { BROADCAST_QUEUE, SettingsReader, marketingUnsubscribeToken } from '@src/modules/platform';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import {
  campaignMessages,
  createDraft,
  fanOutAll,
  fanOutWith,
  insertCustomer,
  sendBroadcast,
  sendNow,
} from '../../support/campaigns';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { mailbox } from '../../support/notifications';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { STORE_ORIGIN } from '../../support/store';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let db: Database;
let owner: AdminApi;

const tokenOf = (id: number) => marketingUnsubscribeToken(t.app.get(TokenService), id);
const storeBase = () => t.app.get<{ http: { storeBaseUrl: string } }>(APP_CONFIG).http.storeBaseUrl;
const consents = (customerId: number) =>
  db.select().from(s.consentRecords).where(eq(s.consentRecords.subjectId, customerId)).orderBy(s.consentRecords.id);
/** Records a consent at the test clock's time, as the account page does (the record's time comes from the injected clock). */
async function setMarketingConsent(database: Database, customerId: number, granted: boolean): Promise<void> {
  await database.update(s.customers).set({ marketingOptIn: granted }).where(eq(s.customers.id, customerId));
  await database.insert(s.consentRecords).values({
    subjectType: 'customer',
    subjectId: customerId,
    purpose: 'marketing',
    granted,
    ip: '',
    createdAt: clock.now(),
  });
}
const customerRow = async (id: number) => (await db.select().from(s.customers).where(eq(s.customers.id, id)))[0]!;

/** What a mailbox provider or the site's page sends: no session, no CSRF token, no anti-bot token. */
function unsubscribe(token: string, options: { form?: boolean; headers?: Record<string, string> } = {}) {
  return t.app.inject({
    method: 'POST',
    url: `/store/v1/marketing/unsubscribe/${token}`,
    headers: {
      origin: STORE_ORIGIN,
      'user-agent': 'Mailbox-Provider/1.0',
      ...(options.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...options.headers,
    },
    ...(options.form ? { payload: 'List-Unsubscribe=One-Click' } : {}),
    remoteAddress: '203.0.113.9',
  });
}

beforeAll(async () => {
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix } });
  db = (await testDb()).db;
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await t.app.get(QueuesService).queue(BROADCAST_QUEUE).obliterate({ force: true });
  await t.app.get(RedisService).cache.flushdb();
  await db.insert(s.settings).values([{ key: 'notifications.broadcast_email_per_second', value: 30 }]);
  await t.app.get(SettingsReader).invalidate();
  mailbox(t).reset();
  fanOutWith(t, { chunkSize: 500, timeBudgetMs: 60_000, highWater: 20_000 });
  owner = await adminWith(t, ['*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await closeTestDb();
});

describe('POST /store/v1/marketing/unsubscribe/:token', () => {
  it('switches marketing off with a consent record of the caller, with no body, and again with 204 and no second record', async () => {
    const id = await insertCustomer(db);
    await setMarketingConsent(db, id, true);
    const res = await unsubscribe(tokenOf(id));
    expect(res.statusCode).toBe(204);
    expect(await customerRow(id)).toMatchObject({ marketingOptIn: false });
    const records = await consents(id);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      subjectType: 'customer',
      purpose: 'marketing',
      granted: false,
      ip: '203.0.113.9',
      userAgent: 'Mailbox-Provider/1.0',
    });
    expect((await unsubscribe(tokenOf(id))).statusCode).toBe(204);
    expect(await consents(id)).toHaveLength(2);
  });

  it('accepts the form body of a mailbox provider’s one-click POST', async () => {
    const id = await insertCustomer(db);
    await setMarketingConsent(db, id, true);
    expect((await unsubscribe(tokenOf(id), { form: true })).statusCode).toBe(204);
    expect(await customerRow(id)).toMatchObject({ marketingOptIn: false });
  });

  it('writes a record for a customer whose switch is on but who has no consent record, and none for one who never agreed', async () => {
    const switchOn = await insertCustomer(db, { marketingOptIn: true });
    const never = await insertCustomer(db);
    expect((await unsubscribe(tokenOf(switchOn))).statusCode).toBe(204);
    expect(await consents(switchOn)).toHaveLength(1);
    expect(await customerRow(switchOn)).toMatchObject({ marketingOptIn: false });
    expect((await unsubscribe(tokenOf(never))).statusCode).toBe(204);
    expect(await consents(never)).toHaveLength(0);
  });

  it('answers 204 and changes nothing for an unknown or anonymized customer, and 410 TOKEN_INVALID for a token that does not verify', async () => {
    expect((await unsubscribe(tokenOf(987654))).statusCode).toBe(204);
    const gone = await insertCustomer(db, { status: 'anonymized', marketingOptIn: true });
    expect((await unsubscribe(tokenOf(gone))).statusCode).toBe(204);
    expect(await customerRow(gone)).toMatchObject({ marketingOptIn: true });
    expect(await consents(gone)).toHaveLength(0);

    const id = await insertCustomer(db);
    const good = tokenOf(id);
    const tampered = `${good.slice(0, -1)}${good.endsWith('0') ? '1' : '0'}`;
    for (const bad of [tampered, `${tokenOf(id + 1).split('.')[0]}.${good.split('.')[1]}`, 'abcdefghij.klmnop']) {
      const res = await unsubscribe(bad);
      expect(res.statusCode, bad).toBe(410);
      expect(res.json().code).toBe('TOKEN_INVALID');
    }
    // Shorter than the contract allows: a validation error, not a token one.
    expect((await unsubscribe('short')).statusCode).toBe(422);
  });

  it('works with no session and no anti-bot token, and takes the customer out of the next marketing audience', async () => {
    const id = await insertCustomer(db);
    await setMarketingConsent(db, id, true);
    const preview = () =>
      owner.post('/admin/notification-campaigns/audience-preview', {
        audience: { customers: {} },
        channels: ['email'],
        purpose: 'marketing',
      });
    expect((await preview()).body.reachable).toBe(1);
    expect((await unsubscribe(tokenOf(id))).statusCode).toBe(204);
    const after = (await preview()).body;
    expect(after.reachable).toBe(0);
    expect(after.excluded.noConsent).toBe(1);
  });
});

describe('a marketing email to a customer', () => {
  async function marketingTo(names: string[]) {
    const ids: number[] = [];
    for (const name of names) {
      const id = await insertCustomer(db, { name, email: `${name.toLowerCase()}@mail.example` });
      await setMarketingConsent(db, id, true);
      ids.push(id);
    }
    const draft = await createDraft(owner, { purpose: 'marketing', channels: ['email'], audience: { customers: {} } });
    expect((await sendNow(owner, draft.id)).status).toBe(202);
    await fanOutAll(t, draft.id);
    return { ids, rows: await campaignMessages(db, draft.id) };
  }

  it('carries the unsubscribe footer and both List-Unsubscribe headers, with that customer’s own token', async () => {
    const { ids, rows } = await marketingTo(['Sam']);
    expect(await sendBroadcast(t, rows[0]!.id, 'email')).toEqual({ outcome: 'sent' });
    const [mail] = mailbox(t).sent;
    const token = tokenOf(ids[0]!);
    expect(mail!.text).toEndWith(`Unsubscribe: ${storeBase()}/unsubscribe?token=${token}`);
    expect(mail!.headers).toEqual({
      'List-Unsubscribe': `<${storeBase()}/store/v1/marketing/unsubscribe/${token}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(mail!.html).toContain(`unsubscribe?token=${token}`);
  });

  it('is not sent to a customer who unsubscribed after the fan-out, while the others still get it', async () => {
    const { ids, rows } = await marketingTo(['Sam', 'Huda']);
    expect((await unsubscribe(tokenOf(ids[0]!))).statusCode).toBe(204);
    const [first, second] = rows;
    expect(await sendBroadcast(t, first!.id, 'email')).toEqual({
      outcome: 'failed',
      reason: 'The recipient is no longer eligible.',
    });
    expect(await sendBroadcast(t, second!.id, 'email')).toEqual({ outcome: 'sent' });
    expect(mailbox(t).sent.map((mail) => mail.to)).toEqual(['huda@mail.example']);
  });

  it('has no unsubscribe footer in a service announcement', async () => {
    const id = await insertCustomer(db, { email: 'sam@mail.example' });
    const draft = await createDraft(owner, { purpose: 'service', channels: ['email'], audience: { customers: {} } });
    await sendNow(owner, draft.id);
    await fanOutAll(t, draft.id);
    const [row] = await campaignMessages(db, draft.id);
    await sendBroadcast(t, row!.id, 'email');
    expect(mailbox(t).sent[0]!.text).not.toContain('nsubscribe');
    expect(mailbox(t).sent[0]!.headers).toBeUndefined();
    expect(id).toBeGreaterThan(0);
  });
});
