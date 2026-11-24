// Seeder of the platform module: the settings the frontend demo starts with.
// Mirrors src/mocks/settings.ts: `adminAllowlistOnly` comes from the demo's `access.restrict`.
import { and, eq, ne } from 'drizzle-orm';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import type { DefaultTemplate } from '../../src/modules/platform';
import { SUPPORT_DEFAULT_TEMPLATES } from '../../src/modules/support';
import { accountIdOfDemo } from './account-ids';
import { type DemoSeed, demoRows } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

/**
 * Seeds the admin allowlist switch.
 *
 * Why: the console reads the IP restriction state from `GET /admin/settings` (key `adminAllowlistOnly`, RULES M14);
 * the demo starts with it on, next to the demo allow rules.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns one report per table
 */
export async function seedPlatform(db: DbExecutor, demo: DemoSeed): Promise<SeedReport[]> {
  const access = demo.state.access as { restrict?: boolean } | undefined;
  const settings = await insertRows(db, s.settings, [{ key: 'adminAllowlistOnly', value: access?.restrict ?? false }]);
  await syncIdentity(db, s.settings);
  return [settings, ...(await seedNotifications(db, demo)), ...(await seedCampaigns(db, demo))];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Finds the default template of one support event and channel.
 *
 * Why: the seed reuses the text the support module ships. A missing template must stop the seed with a message that names it, not with a bare
 * `undefined` error at import time.
 *
 * @param templates the support module's default templates
 * @param key the event, channel and audience of the template
 * @returns the template
 * @throws {Error} when no template has this key (the message names it)
 */
export function requireSupportTemplate(
  templates: readonly DefaultTemplate[],
  key: Pick<DefaultTemplate, 'event' | 'channel' | 'audience'>,
): DefaultTemplate {
  const found = templates.find(
    (template) =>
      template.event === key.event && template.channel === key.channel && template.audience === key.audience,
  );
  if (!found) {
    throw new Error(
      `The default template ${key.event} (${key.channel}, ${key.audience}) is missing from SUPPORT_DEFAULT_TEMPLATES.`,
    );
  }
  return found;
}

/** The customer reply mail the support module ships: nt4 below uses its text, so a seeded database sends the reply with `{{message}}` and `{{link}}`. */
const SUPPORT_REPLY_DEFAULT = requireSupportTemplate(SUPPORT_DEFAULT_TEMPLATES, {
  event: 'support.reply',
  channel: 'email',
  audience: 'customer',
});

/**
 * The customer emails of the demo that the system still sends (`S.settings.notifs`), as templates: the event key, the subject and the text the
 * console's mock shows (`TEXTS` in src/features/settings/mocks/seedMessages.ts), keyed by the demo id.
 */
const CUSTOMER_TEMPLATES: Record<string, { event: string; subject: string; body: string }> = {
  nt1: {
    event: 'order.received',
    subject: 'Your order {{orderId}} is confirmed',
    body: 'Hi {{customerName}}, thanks for your order. We received {{amount}} for "{{service}}". Your receipt is attached and shows the VAT. We will email you the result as soon as the carrier confirms it, usually within a few hours.',
  },
  nt2: {
    event: 'order.completed',
    subject: 'Your unlock is ready',
    body: 'Hi {{customerName}}, good news: the carrier confirmed the unlock for {{orderId}}. Insert a SIM from another network and restart the phone. If anything is unclear, just reply to this email.',
  },
  nt3: {
    event: 'order.failed',
    subject: 'We couldn’t unlock order {{orderId}}',
    body: 'Hi {{customerName}}, the carrier rejected this unlock, so we have refunded {{amount}} to your card. It can take 5 to 10 days to appear. We are sorry it did not work out.',
  },
  // The demo's text is a placeholder for the agent's reply; the real template carries the reply and the ticket link (feature 17).
  nt4: { event: 'support.reply', subject: SUPPORT_REPLY_DEFAULT.subject, body: SUPPORT_REPLY_DEFAULT.body },
  nt6: {
    event: 'payment.failed',
    subject: 'Your payment didn’t go through',
    body: 'Hi, the payment for your unlock was declined by your bank, so we did not start it. Nothing was charged. You can try again or use another card.',
  },
};

/** The merchant messages the seeded log cycles through: the event, its channel and the values of its placeholders. */
const MERCHANT_LOG: ReadonlyArray<{
  event: string;
  channel: 'email';
  variables: Record<string, string>;
}> = [
  {
    event: 'wallet.low_balance',
    channel: 'email',
    variables: { currency: 'USD', available: '42.50', threshold: '50.00' },
  },
  {
    event: 'order.completed',
    channel: 'email',
    variables: { orderId: '48102', service: 'Vodafone UK iPhone Unlock' },
  },
  {
    event: 'invoice.paid',
    channel: 'email',
    variables: { invoiceNumber: 'INV-2026-0042', amount: '250.00', currency: 'USD' },
  },
  { event: 'service.price_changed', channel: 'email', variables: { count: '2' } },
  { event: 'order.failed', channel: 'email', variables: { orderId: '48099', service: 'O2 UK iPhone Unlock' } },
];

/**
 * Seeds the console's Customer emails tab and Notification log (feature 12a): the customer email templates of the demo, the "sent in the last 30 days"
 * messages that make their counts, and a log of 48 recent messages to the demo merchants, a seventh of them failed and an eleventh still queued.
 *
 * Why: the demo's merchant templates (low balance, invoices, order results) are the defaults migration 0009 ships, so the seed adds only the
 * customer emails the demo knows and the migrations do not ship (support reply); the four storefront order and payment mails are
 * migration defaults too (feature 16), and the seed only sets their on/off switch to the demo's. The counts the mock shows (112, 86, 6, 41, 0)
 * become real `sent` rows addressed to the demo customers' accounts (`c3` is account 103); the accounts themselves arrive with the customers
 * seeder, so until then the log shows their address as `***`. Both kinds of recipient are accounts (decision 064): each row keeps the audience
 * whose text it uses in its payload (`customer` for these, `merchant` for the merchant log), as a sent message does, so the 30-day counts of a
 * template stay per audience whatever rank the account holds. Every row has a `seed:` dedupe key, so a second run adds nothing.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns the reports of `notification_templates` and `notifications`
 */
async function seedNotifications(db: DbExecutor, demo: DemoSeed): Promise<SeedReport[]> {
  const settings = demo.state.settings as { notifs?: Array<{ id: string; on: boolean; sent: number }> } | undefined;
  const notifs = (settings?.notifs ?? []).filter((row) => CUSTOMER_TEMPLATES[row.id] !== undefined);
  const templateReport = await insertRows(
    db,
    s.notificationTemplates,
    notifs.map((row) => ({
      event: CUSTOMER_TEMPLATES[row.id]!.event,
      channel: 'email' as const,
      audience: 'customer' as const,
      subject: CUSTOMER_TEMPLATES[row.id]!.subject,
      body: CUSTOMER_TEMPLATES[row.id]!.body,
      isActive: row.on,
    })),
  );

  // The migrations already ship English defaults for four of the five events (feature 16: order received, completed, failed, payment failed), so
  // `insertRows` skips those rows; the demo's on/off switch (the payment failed mail is off) still applies to them, as the console's tab shows it.
  for (const row of notifs) {
    await db
      .update(s.notificationTemplates)
      .set({ isActive: row.on })
      .where(
        and(
          eq(s.notificationTemplates.event, CUSTOMER_TEMPLATES[row.id]!.event),
          eq(s.notificationTemplates.channel, 'email'),
          eq(s.notificationTemplates.audience, 'customer'),
          ne(s.notificationTemplates.isActive, row.on),
        ),
      );
  }

  const customers = demoRows<{ id: string; email: string }>(demo, 'customers');
  const merchants = demoRows<{ id: string; name: string }>(demo, 'merchants').slice(0, 9);
  const log: Array<typeof s.notifications.$inferInsert> = [];
  // The customer messages behind each template's "sent, 30 days": spread evenly over the last 29 days, newest first.
  if (customers.length > 0) {
    for (const row of notifs) {
      const event = CUSTOMER_TEMPLATES[row.id]!.event;
      for (let n = 0; n < row.sent; n += 1) {
        const at = new Date(demo.now - Math.round(((n + 0.5) * 29 * DAY_MS) / row.sent));
        log.push({
          recipientType: 'account',
          recipientId: accountIdOfDemo(customers[n % customers.length]!.id),
          channel: 'email',
          event,
          payload: { variables: { orderId: `SF-${20431 - n}` }, audience: 'customer' },
          status: 'sent',
          sentAt: at,
          attempts: 1,
          dedupeKey: `seed:customer:${event}:${n}`,
          createdAt: at,
          updatedAt: at,
        });
      }
    }
  }
  // The recent merchant log the console lists first: every seventh message failed, every eleventh is still queued.
  if (merchants.length > 0) {
    for (let index = 0; index < 48; index += 1) {
      const kind = MERCHANT_LOG[index % MERCHANT_LOG.length]!;
      const merchant = merchants[index % merchants.length]!;
      const at = new Date(demo.now - (index + 1) * 1.5 * HOUR_MS);
      const failed = index % 7 === 3;
      const queued = !failed && index % 11 === 5;
      log.push({
        recipientType: 'account',
        recipientId: accountIdOfDemo(merchant.id),
        channel: kind.channel,
        event: kind.event,
        payload: { variables: { merchantName: merchant.name, ...kind.variables }, audience: 'merchant' },
        status: failed ? 'failed' : queued ? 'queued' : 'sent',
        sentAt: failed || queued ? null : at,
        attempts: queued ? 0 : failed ? 5 : 1,
        error: failed ? '550 5.1.1 The mailbox does not exist.' : null,
        dedupeKey: `seed:merchant:${index}`,
        createdAt: at,
        updatedAt: at,
      });
    }
  }
  const notificationReport = await insertRows(db, s.notifications, log);
  await syncIdentity(db, s.notificationTemplates);
  await syncIdentity(db, s.notifications);
  return [templateReport, notificationReport];
}

/** The seeded Owner (`staff_users` 1 of the identity seed) writes the seeded campaigns. */
const SEED_OWNER_ID = 1;
/** The seeded merchant who reads the sent campaign. */
const SEED_MERCHANT_ID = 1;

const SEED_CAMPAIGN_CONTENT = {
  maintenance: {
    title: 'Scheduled maintenance on Friday',
    body: 'Hello {{name}},\nThe portal will be read-only on Friday from 02:00 to 03:00 UTC. Orders placed before then are not affected.',
  },
  ramadan: { title: 'Ramadan offer', body: 'Hello {{name}},\nAll iPhone unlocks are 15% off during Ramadan.' },
  services: {
    title: 'New unlock services',
    body: 'Hello {{name}},\nWe added new unlock services for Samsung and Xiaomi.',
  },
} as const;

/**
 * Seeds the notification center (feature 23): three campaigns as the console mock shows them, with the in-app items and the
 * emails of the sent one.
 *
 * Why: plan section 11: `1` "Scheduled maintenance on Friday" (service, in-app and email, everyone, sent; read by the Owner and
 * merchant 1, unread by the first customer with an account), `2` "Ramadan offer" (marketing email to customers, scheduled 7 days
 * ahead), `3` "New unlock services" (service, in-app to merchants, a draft). The sent campaign's emails are dated before the recent
 * merchant log of feature 12a, so that log still lists its own 48 messages first.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns one report per table
 */
async function seedCampaigns(db: DbExecutor, demo: DemoSeed): Promise<SeedReport[]> {
  const owner = await db.select({ id: s.staffUsers.id }).from(s.staffUsers).where(eq(s.staffUsers.id, SEED_OWNER_ID));
  // The campaigns need their author; a database without the identity seed gets none.
  if (owner.length === 0) return [];
  const customer = demoRows<{ id: string; hasAccount: boolean }>(demo, 'customers').find((row) => row.hasAccount);
  const sentAt = new Date(demo.now - 3.5 * DAY_MS);
  const createdAt = new Date(demo.now - 4 * DAY_MS);
  const everyone = { staff: {}, merchants: {}, customers: { hasAccount: true } };
  // The people the sent campaign reached: a staff member and two accounts, each in the group of its rank. The email row keeps that group's
  // audience in its payload, as the fan-out writes it.
  const people: Array<{
    type: 'staff' | 'account';
    id: number;
    audience: 'staff' | 'merchant' | 'customer';
    read: boolean;
  }> = [
    { type: 'staff', id: SEED_OWNER_ID, audience: 'staff', read: true },
    { type: 'account', id: SEED_MERCHANT_ID, audience: 'merchant', read: true },
    ...(customer
      ? [{ type: 'account' as const, id: accountIdOfDemo(customer.id), audience: 'customer' as const, read: false }]
      : []),
  ];
  // The seed writes fixed ids (the console mock's), which the insert type of a generated identity column leaves out.
  const campaignRows: Array<typeof s.notificationCampaigns.$inferInsert & { readonly id: number }> = [
    {
      id: 1,
      name: 'Scheduled maintenance on Friday',
      purpose: 'service',
      channels: ['in_app', 'email'],
      audience: everyone,
      content: SEED_CAMPAIGN_CONTENT.maintenance,
      link: { merchant: '/account/orders', customer: '/account/orders' },
      status: 'sent',
      queuedAt: sentAt,
      startedAt: sentAt,
      finishedAt: sentAt,
      expectedRecipients: people.length,
      recipients: people.length,
      stats: {
        planned: { inApp: people.length, email: people.length },
        skipped: { optedOut: 0, noAccount: 0 },
      },
      chunksDone: 1,
      createdBy: SEED_OWNER_ID,
      updatedBy: SEED_OWNER_ID,
      createdAt,
      updatedAt: sentAt,
    },
    {
      id: 2,
      name: 'Ramadan offer',
      purpose: 'marketing',
      channels: ['email'],
      audience: { customers: {} },
      content: SEED_CAMPAIGN_CONTENT.ramadan,
      link: { customer: '/' },
      status: 'scheduled',
      scheduledAt: new Date(demo.now + 7 * DAY_MS),
      createdBy: SEED_OWNER_ID,
      updatedBy: SEED_OWNER_ID,
      createdAt: new Date(demo.now - DAY_MS),
      updatedAt: new Date(demo.now - DAY_MS),
    },
    {
      id: 3,
      name: 'New unlock services',
      purpose: 'service',
      channels: ['in_app'],
      audience: { merchants: {} },
      content: SEED_CAMPAIGN_CONTENT.services,
      link: { merchant: '/account/services' },
      status: 'draft',
      createdBy: SEED_OWNER_ID,
      createdAt: new Date(demo.now - 2 * HOUR_MS),
      updatedAt: new Date(demo.now - 2 * HOUR_MS),
    },
  ];
  const campaigns = await insertRows(db, s.notificationCampaigns, campaignRows);
  const inbox = await insertRows(
    db,
    s.notificationInbox,
    people.map((person, index) => ({
      id: index + 1,
      recipientType: person.type,
      recipientId: person.id,
      campaignId: 1,
      category: 'announcement' as const,
      readAt: person.read ? new Date(sentAt.getTime() + (index + 1) * HOUR_MS) : null,
      createdAt: sentAt,
      updatedAt: sentAt,
    })),
  );
  const emails = await insertRows(
    db,
    s.notifications,
    people.map((person) => ({
      recipientType: person.type,
      recipientId: person.id,
      channel: 'email' as const,
      event: 'broadcast.announcement',
      payload: { audience: person.audience },
      status: 'sent' as const,
      sentAt,
      attempts: 1,
      campaignId: 1,
      dedupeKey: `campaign-1:email:${person.type}-${person.id}`,
      createdAt: sentAt,
      updatedAt: sentAt,
    })),
  );
  await syncIdentity(db, s.notificationCampaigns);
  await syncIdentity(db, s.notificationInbox);
  await syncIdentity(db, s.notifications);
  return [campaigns, inbox, { ...emails, table: 'notifications (campaign emails)' }];
}
