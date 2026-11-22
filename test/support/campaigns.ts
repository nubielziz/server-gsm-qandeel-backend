// Helpers for the notification center tests (feature 23): people of the three audiences, consent rows, a campaign made through the
// route, the fan-out with a small chunk, the bulk sender run as the worker would, and readers of the rows a campaign makes.
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import {
  BroadcastSendProcessor,
  CampaignFanOut,
  type CampaignFanOutOptions,
  type CampaignFanOutResult,
  type DeliveryOutcome,
} from '@src/modules/platform';
import type { AdminApi } from './admin-api';
import type { TestApp } from './app';

/** A job as the processors read it (`data`, `attemptsMade`, `opts.attempts`). */
export const jobLike = <T>(data: T, attemptsMade = 0, attempts = 6) =>
  ({ data, attemptsMade, opts: { attempts } }) as never;

/**
 * Inserts a customer.
 *
 * @param db the test database
 * @param values columns to override (default: an active account holder in English whose address is proven; pass `emailVerifiedAt: null` for
 *   one that never was)
 * @returns the id
 */
export async function insertCustomer(
  db: Database,
  values: Partial<typeof s.customers.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(s.customers)
    .values({
      email: `customer-${randomUUID()}@mail.example`,
      name: 'Test Customer',
      hasAccount: true,
      status: 'active',
      // A customer whose address was proven (a used sign-in or verification link): campaigns reach only those (decision 053).
      emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...values,
    })
    .returning({ id: s.customers.id });
  return row!.id;
}

/**
 * Records a customer's marketing choice the way the account page does: the switch and a consent record.
 *
 * @param db the test database
 * @param customerId the customer
 * @param granted yes or no
 */
export async function setMarketingConsent(db: Database, customerId: number, granted: boolean): Promise<void> {
  await db.update(s.customers).set({ marketingOptIn: granted }).where(eq(s.customers.id, customerId));
  await db
    .insert(s.consentRecords)
    .values({ subjectType: 'customer', subjectId: customerId, purpose: 'marketing', granted, ip: '' });
}

/** A campaign as `POST /admin/notification-campaigns` takes it. */
export const CAMPAIGN_INPUT = {
  name: 'Scheduled maintenance on Friday',
  purpose: 'service',
  channels: ['in_app', 'email'],
  audience: { staff: {}, merchants: {}, customers: { hasAccount: true } },
  content: { title: 'Maintenance for {{name}}', body: 'The portal is read-only on Friday.' },
  link: { customer: '/account/orders', merchant: '/merchant/wallet' },
};

/**
 * Creates a draft through the route.
 *
 * @param admin a staff member with `broadcasts:send`
 * @param changes fields to change in {@link CAMPAIGN_INPUT}
 * @returns the draft as the route answered it
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the route's JSON answer: tests read a few fields
export async function createDraft(admin: AdminApi, changes: Record<string, unknown> = {}): Promise<any> {
  const res = await admin.post('/admin/notification-campaigns', { ...CAMPAIGN_INPUT, ...changes });
  if (res.status !== 201) throw new Error(`create answered ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

/**
 * Counts an audience through the route and sends the campaign with that number.
 *
 * @param admin a staff member with both broadcast permissions
 * @param id the campaign
 * @returns the send's answer
 */
export async function sendNow(admin: AdminApi, id: number) {
  const campaign = (await admin.get(`/admin/notification-campaigns/${id}`)).body;
  const preview = await admin.post('/admin/notification-campaigns/audience-preview', {
    audience: campaign.audience,
    channels: campaign.channels,
    purpose: campaign.purpose,
  });
  return admin.post(`/admin/notification-campaigns/${id}/send`, { confirmRecipients: preview.body.reachable });
}

/**
 * Sets the pacing of the app's fan-out (production uses 500 people per chunk; tests use a few).
 *
 * @param t the running test app
 * @param options the pacing to use until the next call
 * @returns the fan-out service
 */
export function fanOutWith(t: TestApp, options: Partial<CampaignFanOutOptions>): CampaignFanOut {
  const fanOut = t.app.get(CampaignFanOut);
  // The options are a provider value read on each run; replacing the field is the test's way to shrink the chunk without a second app.
  const current = Reflect.get(fanOut, 'options') as CampaignFanOutOptions;
  Reflect.set(fanOut, 'options', { ...current, ...options });
  return fanOut;
}

/**
 * Runs the fan-out of a campaign until it ends (continuations included, as the queue would run them one after another).
 *
 * @param t the running test app
 * @param campaignId the campaign
 * @returns every run's result
 */
export async function fanOutAll(t: TestApp, campaignId: number): Promise<CampaignFanOutResult[]> {
  const results: CampaignFanOutResult[] = [];
  for (let run = 0; run < 100; run += 1) {
    const result = await t.app.get(CampaignFanOut).run(campaignId);
    results.push(result);
    if (result.outcome !== 'continued') return results;
  }
  throw new Error('The fan-out did not end within 100 runs.');
}

/**
 * Runs the bulk sender for one row, as the worker would.
 *
 * @param t the running test app
 * @param notificationId the row
 * @param channel its channel
 * @param attemptsMade the attempts before this one
 * @returns what the attempt did
 */
export function sendBroadcast(
  t: TestApp,
  notificationId: number,
  channel: 'email' | 'telegram',
  attemptsMade = 0,
): Promise<DeliveryOutcome> {
  return t.app.get(BroadcastSendProcessor).process(jobLike({ notificationId, channel }, attemptsMade));
}

/**
 * Reads the `notifications` rows of a campaign, oldest first.
 *
 * @param db the test database
 * @param campaignId the campaign
 * @returns the rows
 */
export function campaignMessages(db: Database, campaignId: number) {
  return db
    .select()
    .from(s.notifications)
    .where(eq(s.notifications.campaignId, campaignId))
    .orderBy(asc(s.notifications.id));
}

/**
 * Reads the in-app items of a campaign, oldest first.
 *
 * @param db the test database
 * @param campaignId the campaign
 * @returns the rows
 */
export function campaignItems(db: Database, campaignId: number) {
  return db
    .select()
    .from(s.notificationInbox)
    .where(eq(s.notificationInbox.campaignId, campaignId))
    .orderBy(asc(s.notificationInbox.id));
}

/**
 * Reads a campaign row.
 *
 * @param db the test database
 * @param id the campaign
 * @returns the row
 */
export async function campaignRow(db: Database, id: number) {
  const [row] = await db.select().from(s.notificationCampaigns).where(eq(s.notificationCampaigns.id, id));
  return row!;
}

/**
 * Reads the audit entries of a campaign, oldest first.
 *
 * @param db the test database
 * @param id the campaign
 * @returns the rows
 */
export function campaignAudit(db: Database, id: number) {
  return db
    .select()
    .from(s.auditLogs)
    .where(and(eq(s.auditLogs.entityType, 'notification_campaign'), eq(s.auditLogs.entityId, id)))
    .orderBy(asc(s.auditLogs.id));
}
