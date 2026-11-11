// Seeder of the platform module: the settings the frontend demo starts with.
// Mirrors src/mocks/settings.ts: `adminAllowlistOnly` comes from the demo's `access.restrict`.
import { and, eq, ne } from 'drizzle-orm';
import type { AppConfig } from '../../src/config';
import { EncryptionService, TokenService } from '../../src/infra/crypto';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import type { JsonObject } from '../../src/common/contract';
import { WEBHOOK_SECRET_AAD } from '../../src/modules/platform/webhooks/webhook-deliveries';
import type { DefaultTemplate } from '../../src/modules/platform';
import { SUPPORT_DEFAULT_TEMPLATES } from '../../src/modules/support';
import {
  invoicePaid,
  orderStatusChanged,
  servicePriceChanged,
  walletLowBalance,
} from '../../src/modules/platform/webhooks/webhook-events';
import { type DemoSeed, demoNumericId, demoRows } from './demo-state';
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
export async function seedPlatform(db: DbExecutor, demo: DemoSeed, config?: AppConfig): Promise<SeedReport[]> {
  const access = demo.state.access as { restrict?: boolean } | undefined;
  const settings = await insertRows(db, s.settings, [{ key: 'adminAllowlistOnly', value: access?.restrict ?? false }]);
  await syncIdentity(db, s.settings);
  // The endpoints need the encryption key and the deliveries the token pepper (the event ids): without a configuration there are none.
  const webhooks = config ? await seedWebhooks(db, demo, config) : [];
  return [settings, ...webhooks, ...(await seedNotifications(db, demo)), ...(await seedCampaigns(db, demo))];
}

const MINUTE_MS = 60_000;

/** The events the seeded deliveries cycle through (the public four). */
const SEED_EVENTS = ['order.status_changed', 'wallet.low_balance', 'invoice.paid', 'service.price_changed'] as const;

/** The contract of each seeded event: its documented example is the base of the seeded `data`. */
const SEED_EVENT_CONTRACTS = {
  'order.status_changed': orderStatusChanged,
  'wallet.low_balance': walletLowBalance,
  'invoice.paid': invoicePaid,
  'service.price_changed': servicePriceChanged,
} as const;

/**
 * The `data` of a seeded delivery: the documented example of its event with the ids moved per row.
 *
 * Why: the console's delivery drawer shows the request as sent, so every event carries its own payload (an invoice for
 * `invoice.paid`, not an order); the payload schema checks it, so a change of an event's contract cannot leave the seed behind.
 *
 * @param event the event name
 * @param index the row number, which moves the order or invoice id
 * @returns the event data
 */
function seedEventData(event: (typeof SEED_EVENTS)[number], index: number): JsonObject {
  const example = SEED_EVENT_CONTRACTS[event].example as JsonObject;
  const moved: JsonObject =
    event === 'order.status_changed'
      ? { orderId: 48100 - index }
      : event === 'invoice.paid'
        ? { invoiceId: 300 + index, number: `INV-2026-${String(300 + index).padStart(4, '0')}` }
        : {};
  return SEED_EVENT_CONTRACTS[event].payload.parse({ ...example, ...moved });
}

/**
 * Seeds the webhook log the console's Webhook deliveries tab shows: an endpoint for each of the first four demo merchants and 36
 * deliveries over them, newest first, with the outcomes of the frontend mock (`deliveryRows` in
 * src/features/settings/mocks/seedWebhooks.ts): mostly delivered, some refused with 500, one that never answered, one waiting.
 *
 * Why: the demo has no webhook log; the console mock made one up. The same rows through the real API keep the screen alive in
 * development. The event names are the real ones (the mock's `order.completed` is illustrative) and the signing secret of every
 * endpoint is a development value.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @param config the application configuration (encryption keys and token pepper)
 * @returns the reports of `webhook_endpoints` and `webhook_deliveries`
 */
async function seedWebhooks(db: DbExecutor, demo: DemoSeed, config: AppConfig): Promise<SeedReport[]> {
  const encryption = new EncryptionService(config);
  const tokens = new TokenService(config);
  const merchants = demoRows<{ id: string; name: string }>(demo, 'merchants').slice(0, 4);
  const endpoints = merchants.map((merchant, index) => ({
    id: index + 1,
    clientId: demoNumericId(merchant.id),
    name: merchant.name,
    url: `https://hooks.${merchant.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example/gsm`,
  }));
  const endpointReport = await insertRows(
    db,
    s.webhookEndpoints,
    endpoints.map((endpoint) => ({
      id: endpoint.id,
      clientId: endpoint.clientId,
      url: endpoint.url,
      secretEnc: encryption.encrypt(`whsec_seed_${endpoint.id}_development_only`, WEBHOOK_SECRET_AAD),
      events: [...SEED_EVENTS],
      isActive: true,
      failureCount: 0,
    })),
  );
  const deliveries = Array.from({ length: 36 }, (_, index) => {
    const endpoint = endpoints[index % endpoints.length]!;
    const event = SEED_EVENTS[index % SEED_EVENTS.length]!;
    const at = new Date(demo.now - (index + 1) * 25 * MINUTE_MS);
    const eventId = `evt_${tokens.hash(`seed-delivery:${index}`).slice(0, 24)}`;
    const kind = index % 9 === 2 ? 'refused' : index % 9 === 5 ? 'silent' : index % 9 === 7 ? 'waiting' : 'delivered';
    return {
      id: 36 - index,
      endpointId: endpoint.id,
      event,
      eventId,
      payload: { id: eventId, type: event, createdAt: at.toISOString(), data: seedEventData(event, index) },
      // A failed delivery used its 8 attempts; a waiting one is on its 2nd to 4th.
      attempt: kind === 'delivered' ? 1 : kind === 'waiting' ? 2 + (index % 3) : 8,
      status:
        kind === 'delivered' ? ('delivered' as const) : kind === 'waiting' ? ('pending' as const) : ('failed' as const),
      responseCode: kind === 'refused' ? 500 : kind === 'delivered' ? 200 : null,
      responseBody: kind === 'refused' ? '{"error":"internal"}' : kind === 'delivered' ? '{"ok":true}' : null,
      error: kind === 'silent' ? 'The endpoint did not answer within 10 seconds.' : null,
      nextRetryAt: kind === 'waiting' ? new Date(demo.now + (index + 1) * MINUTE_MS) : null,
      createdAt: at,
    };
  });
  const deliveryReport = await insertRows(db, s.webhookDeliveries, deliveries);
  await syncIdentity(db, s.webhookEndpoints);
  await syncIdentity(db, s.webhookDeliveries);
  return [endpointReport, deliveryReport];
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
 * @param key the event, channel, audience and language of the template
 * @returns the template
 * @throws {Error} when no template has this key (the message names it)
 */
export function requireSupportTemplate(
  templates: readonly DefaultTemplate[],
  key: Pick<DefaultTemplate, 'event' | 'channel' | 'audience' | 'locale'>,
): DefaultTemplate {
  const found = templates.find(
    (template) =>
      template.event === key.event &&
      template.channel === key.channel &&
      template.audience === key.audience &&
      template.locale === key.locale,
  );
  if (!found) {
    throw new Error(
      `The default template ${key.event} (${key.channel}, ${key.audience}, ${key.locale}) is missing from SUPPORT_DEFAULT_TEMPLATES.`,
    );
  }
  return found;
}

/** The customer reply mail the support module ships: nt4 below uses its text, so a seeded database sends the reply with `{{message}}` and `{{link}}`. */
const SUPPORT_REPLY_DEFAULT = requireSupportTemplate(SUPPORT_DEFAULT_TEMPLATES, {
  event: 'support.reply',
  channel: 'email',
  audience: 'customer',
  locale: 'en',
});

/**
 * The six customer emails of the demo (`S.settings.notifs`), as templates: the event key, the subject and the text the console's mock shows
 * (`TEXTS` in src/features/settings/mocks/seedMessages.ts), keyed by the demo id.
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
  nt5: {
    event: 'checkout.abandoned',
    subject: 'You left something behind',
    // The demo's text, with the greeting and the one-click link of the recovery mail (feature 19: `customerName`, `device` and `link` are the event's variables).
    body: 'Hi {{customerName}}, you started an unlock for {{device}} and did not finish paying. Your basket is saved: {{link}} takes you back to the payment step. No account needed.',
  },
  nt6: {
    event: 'payment.failed',
    subject: 'Your payment didn’t go through',
    body: 'Hi, the payment for your unlock was declined by your bank, so we did not start it. Nothing was charged. You can try again or use another card.',
  },
};

/** The merchant messages the seeded log cycles through: the event, its channel and the values of its placeholders. */
const MERCHANT_LOG: ReadonlyArray<{
  event: string;
  channel: 'email' | 'telegram';
  variables: Record<string, string>;
}> = [
  {
    event: 'wallet.low_balance',
    channel: 'email',
    variables: { currency: 'USD', available: '42.50', threshold: '50.00' },
  },
  {
    event: 'order.completed',
    channel: 'telegram',
    variables: { orderId: '48102', service: 'Vodafone UK iPhone Unlock' },
  },
  { event: 'deposit.approved', channel: 'email', variables: { amount: '250.00', currency: 'USD' } },
  {
    event: 'invoice.paid',
    channel: 'email',
    variables: { invoiceNumber: 'INV-2026-0042', amount: '250.00', currency: 'USD' },
  },
  { event: 'service.price_changed', channel: 'email', variables: { count: '2' } },
  { event: 'order.failed', channel: 'email', variables: { orderId: '48099', service: 'O2 UK iPhone Unlock' } },
];

/**
 * Seeds the console's Customer emails tab and Notification log (feature 12a): the six customer email templates of the demo, the "sent in the last 30 days"
 * messages that make their counts, and a log of 48 recent messages to the demo merchants, a seventh of them failed and an eleventh still queued.
 *
 * Why: the demo's merchant templates (low balance, invoices, order results, Telegram) are the defaults migration 0009 ships, so the seed adds only the
 * customer emails the demo knows and the migrations do not ship (support reply, abandoned checkout); the four storefront order and payment mails are
 * migration defaults too (feature 16), and the seed only sets their on/off switch to the demo's. The counts the mock shows (112, 86, 6, 41, 17, 0) become real `sent` rows with the demo customers' ids; the customers
 * themselves arrive with feature 14b, so until then the log shows their address as `***`. Every row has a `seed:` dedupe key, so a second run adds nothing.
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
      locale: 'en',
      subject: CUSTOMER_TEMPLATES[row.id]!.subject,
      body: CUSTOMER_TEMPLATES[row.id]!.body,
      isActive: row.on,
    })),
  );

  // The migrations already ship English defaults for four of the six events (feature 16: order received, completed, failed, payment failed), so
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
          eq(s.notificationTemplates.locale, 'en'),
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
          recipientType: 'customer',
          recipientId: demoNumericId(customers[n % customers.length]!.id),
          channel: 'email',
          event,
          payload: { variables: { orderId: `SF-${20431 - n}` } },
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
        recipientType: 'client',
        recipientId: demoNumericId(merchant.id),
        channel: kind.channel,
        event: kind.event,
        // The merchants of the seed have no linked chat, so a Telegram row carries its chat in the payload (the log masks it from there).
        payload: {
          variables: { merchantName: merchant.name, ...kind.variables },
          ...(kind.channel === 'telegram' ? { chatId: `70010${index % 5}` } : {}),
        },
        status: failed ? 'failed' : queued ? 'queued' : 'sent',
        sentAt: failed || queued ? null : at,
        attempts: queued ? 0 : failed ? 5 : 1,
        error: failed
          ? kind.channel === 'telegram'
            ? 'Telegram refused the message: Bad Request: chat not found'
            : '550 5.1.1 The mailbox does not exist.'
          : null,
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
    en: {
      title: 'Scheduled maintenance on Friday',
      body: 'Hello {{name}},\nThe portal will be read-only on Friday from 02:00 to 03:00 UTC. Orders placed before then are not affected.',
    },
    ar: {
      title: 'صيانة مجدولة يوم الجمعة',
      body: 'مرحباً {{name}}،\nستكون البوابة للقراءة فقط يوم الجمعة من 02:00 إلى 03:00 بتوقيت UTC. لا تتأثر الطلبات المقدمة قبل ذلك.',
    },
  },
  ramadan: {
    en: { title: 'Ramadan offer', body: 'Hello {{name}},\nAll iPhone unlocks are 15% off during Ramadan.' },
    ar: { title: 'عرض رمضان', body: 'مرحباً {{name}}،\nخصم 15% على جميع خدمات فك قفل الآيفون خلال شهر رمضان.' },
  },
  services: {
    en: { title: 'New unlock services', body: 'Hello {{name}},\nWe added new unlock services for Samsung and Xiaomi.' },
    ar: { title: 'خدمات فك قفل جديدة', body: 'مرحباً {{name}}،\nأضفنا خدمات فك قفل جديدة لأجهزة سامسونج وشاومي.' },
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
  const people: Array<{ type: 'staff' | 'client' | 'customer'; id: number; read: boolean }> = [
    { type: 'staff', id: SEED_OWNER_ID, read: true },
    { type: 'client', id: SEED_MERCHANT_ID, read: true },
    ...(customer ? [{ type: 'customer' as const, id: demoNumericId(customer.id), read: false }] : []),
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
      link: { merchant: '/merchant/orders', customer: '/account/orders' },
      status: 'sent',
      queuedAt: sentAt,
      startedAt: sentAt,
      finishedAt: sentAt,
      expectedRecipients: people.length,
      recipients: people.length,
      stats: {
        planned: { inApp: people.length, email: people.length, telegram: 0 },
        skipped: { optedOut: 0, noTelegram: 0, noAccount: 0 },
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
      link: { merchant: '/merchant/services' },
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
      payload: {},
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
