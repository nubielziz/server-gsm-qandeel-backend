// Integration test of the data migration that retires Telegram for merchants (decision 062): the SQL is run on rows written before it (the
// merchant's Telegram texts, campaigns that list the channel, Telegram messages still queued for a merchant, the rate setting, the chat-link
// tokens and the Telegram switches in the stored preferences) and run again, as a database that already has it would. The column
// "clients"."telegram_chat_id" stays in this step, so the test also proves the migration leaves it, the operations alerts and every other row alone.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertMerchant, insertRole, insertStaff } from '../../support/auth';

const FOLDER = join(import.meta.dir, '../../../drizzle');
// The migration is found by its name, not its number: the number is given again when the branches are merged.
const NAME = readdirSync(FOLDER).find((file) => file.endsWith('_retired_features.sql'));

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

async function migrate(): Promise<void> {
  const { pool } = await testDb();
  await pool.query(readFileSync(join(FOLDER, NAME ?? 'missing'), 'utf8'));
}

async function insertTemplate(
  event: string,
  channel: 'email' | 'telegram',
  audience: 'merchant' | 'staff' | 'customer',
): Promise<void> {
  const { db } = await testDb();
  await db.insert(s.notificationTemplates).values({ event, channel, audience, subject: 'S', body: 'B' });
}

describe('the migration that retires Telegram for merchants', () => {
  it('exists in the migrations folder', () => {
    expect(NAME).toBeDefined();
  });

  it('deletes the merchant’s Telegram texts and keeps every email text and the Telegram texts of the staff alerts', async () => {
    const { db } = await testDb();
    await insertTemplate('wallet.low_balance', 'telegram', 'merchant');
    await insertTemplate('wallet.low_balance', 'email', 'merchant');
    await insertTemplate('support.reply', 'telegram', 'merchant');
    await insertTemplate('telegram.linked', 'telegram', 'merchant');
    await insertTemplate('alert.fired', 'telegram', 'staff');
    await insertTemplate('alert.fired', 'email', 'staff');
    await insertTemplate('order.completed', 'email', 'customer');
    const keys = async () =>
      (await db.select().from(s.notificationTemplates).orderBy(asc(s.notificationTemplates.id))).map(
        (row) => `${row.event}|${row.channel}|${row.audience}`,
      );

    await migrate();
    const once = await keys();
    expect(once).toEqual([
      'wallet.low_balance|email|merchant',
      'alert.fired|telegram|staff',
      'alert.fired|email|staff',
      'order.completed|email|customer',
    ]);
    await migrate();
    expect(await keys()).toEqual(once);
  });

  it('takes the retired channel out of a campaign that has another one, cancels a scheduled campaign that had only that channel, and leaves the rest', async () => {
    const { db } = await testDb();
    const author = await insertStaff(db, await insertRole(db, ['*']));
    const campaign = async (name: string, status: 'draft' | 'scheduled' | 'sent', channels: string[]) =>
      (
        await db
          .insert(s.notificationCampaigns)
          .values({
            name,
            purpose: 'service',
            channels,
            audience: { merchants: {} },
            content: { title: 't', body: 'b' },
            status,
            createdBy: author,
            ...(status === 'scheduled' ? { scheduledAt: new Date('2026-12-01T00:00:00.000Z') } : {}),
          })
          .returning({ id: s.notificationCampaigns.id })
      )[0]!.id;
    const mixedSent = await campaign('mixed sent', 'sent', ['in_app', 'email', 'telegram']);
    const mixedScheduled = await campaign('mixed scheduled', 'scheduled', ['email', 'telegram']);
    const onlyScheduled = await campaign('only scheduled', 'scheduled', ['telegram']);
    const onlyDraft = await campaign('only draft', 'draft', ['telegram']);
    const plain = await campaign('plain', 'scheduled', ['in_app', 'email']);
    const rows = async () => await db.select().from(s.notificationCampaigns).orderBy(asc(s.notificationCampaigns.id));
    const of = (list: Awaited<ReturnType<typeof rows>>, id: number) => list.find((row) => row.id === id)!;

    await migrate();
    const once = await rows();
    expect(of(once, mixedSent)).toMatchObject({ status: 'sent', channels: ['in_app', 'email'] });
    expect(of(once, mixedScheduled)).toMatchObject({ status: 'scheduled', channels: ['email'] });
    expect(of(once, onlyScheduled)).toMatchObject({ status: 'cancelled', channels: ['telegram'] });
    expect(of(once, onlyScheduled).cancelledAt).not.toBeNull();
    expect(of(once, onlyDraft)).toMatchObject({ status: 'draft', channels: ['telegram'] });
    expect(of(once, plain)).toMatchObject({ status: 'scheduled', channels: ['in_app', 'email'], cancelledAt: null });
    await migrate();
    expect(await rows()).toEqual(once);
  });

  it('ends a Telegram message still queued for an account, and leaves the operations alerts, sent messages and email alone', async () => {
    const { db } = await testDb();
    const merchant = await insertMerchant(db, { telegramChatId: '7001' });
    const row = (values: Partial<typeof s.notifications.$inferInsert>) => ({
      // Decision 064: the log says `account` for a merchant and a customer alike.
      recipientType: 'account' as const,
      recipientId: merchant,
      channel: 'telegram' as const,
      event: 'wallet.low_balance',
      payload: { chatId: '7001' },
      status: 'queued' as const,
      ...values,
    });
    await db
      .insert(s.notifications)
      .values([
        row({}),
        row({ event: 'order.completed' }),
        row({ recipientType: 'staff', recipientId: 0, event: 'alert.fired' }),
        row({ status: 'sent', sentAt: new Date('2026-11-01T00:00:00.000Z') }),
        row({ channel: 'email' }),
      ]);
    const states = async () =>
      (await db.select().from(s.notifications).orderBy(asc(s.notifications.id))).map(
        (n) => `${n.recipientType}:${n.channel}:${n.status}:${n.error ?? ''}`,
      );

    await migrate();
    const once = await states();
    expect(once).toEqual([
      'account:telegram:failed:Telegram is no longer used for this message.',
      'account:telegram:failed:Telegram is no longer used for this message.',
      'staff:telegram:queued:',
      'account:telegram:sent:',
      'account:email:queued:',
    ]);
    await migrate();
    expect(await states()).toEqual(once);
  });

  it('deletes the rate setting of the retired channel and the chat-link tokens, and keeps the other settings and tokens', async () => {
    const { db } = await testDb();
    const merchant = await insertMerchant(db);
    await db.insert(s.settings).values([
      { key: 'notifications.broadcast_telegram_per_second', value: 20 },
      { key: 'notifications.broadcast_email_per_second', value: 5 },
    ]);
    const token = (purpose: 'telegram_link' | 'reset', hash: string) => ({
      purpose,
      subjectType: 'account' as const,
      subjectId: merchant,
      tokenHash: hash,
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    });
    await db.insert(s.authTokens).values([token('telegram_link', 'a'.repeat(64)), token('reset', 'b'.repeat(64))]);

    await migrate();
    expect((await db.select().from(s.settings)).map((row) => row.key)).toEqual([
      'notifications.broadcast_email_per_second',
    ]);
    expect((await db.select().from(s.authTokens)).map((row) => row.purpose)).toEqual(['reset']);
    await migrate();
    expect(await db.select().from(s.settings)).toHaveLength(1);
    expect(await db.select().from(s.authTokens)).toHaveLength(1);
  });

  it('takes the Telegram switch out of every stored event preference, keeping the email switch, the other keys and the value of an event that is not an object', async () => {
    const { db } = await testDb();
    const stored = {
      lowBalanceThreshold: '50.0000',
      other: { a: 1 },
      events: {
        'wallet.low_balance': { email: true, telegram: true },
        'order.completed': { telegram: false },
        'invoice.paid': 'bad',
      },
    };
    const withSwitch = await insertMerchant(db, { notificationPrefs: stored });
    const untouched = await insertMerchant(db, { notificationPrefs: { events: { 'invoice.paid': { email: false } } } });
    const noEvents = await insertMerchant(db, { notificationPrefs: { events: 'nope' } });
    const empty = await insertMerchant(db);
    const prefsOf = async (id: number) =>
      (await db.select().from(s.clients).where(eq(s.clients.id, id)))[0]!.notificationPrefs;

    await migrate();
    expect(await prefsOf(withSwitch)).toEqual({
      lowBalanceThreshold: '50.0000',
      other: { a: 1 },
      events: { 'wallet.low_balance': { email: true }, 'order.completed': {}, 'invoice.paid': 'bad' },
    });
    expect(await prefsOf(untouched)).toEqual({ events: { 'invoice.paid': { email: false } } });
    expect(await prefsOf(noEvents)).toEqual({ events: 'nope' });
    expect(await prefsOf(empty)).toEqual({});
    await migrate();
    expect(await prefsOf(withSwitch)).toEqual({
      lowBalanceThreshold: '50.0000',
      other: { a: 1 },
      events: { 'wallet.low_balance': { email: true }, 'order.completed': {}, 'invoice.paid': 'bad' },
    });
  });

  it('runs on an empty database, and leaves the chat column of the merchants as it is', async () => {
    const { db, pool } = await testDb();
    await migrate();
    const merchant = await insertMerchant(db, { telegramChatId: '7001' });
    const [before] = await db.select().from(s.clients).where(eq(s.clients.id, merchant));

    await migrate();
    const [after] = await db.select().from(s.clients).where(eq(s.clients.id, merchant));
    expect(after).toEqual(before);
    expect(after?.telegramChatId).toBe('7001');
    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from information_schema.columns where table_name = 'clients' and column_name = 'telegram_chat_id'`,
    );
    expect(rows[0]?.count).toBe('1');
  });
});
