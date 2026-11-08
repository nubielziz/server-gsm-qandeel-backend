// The seed of feature 12a (`bun run db:seed`): the customer email templates of the console's Customer emails tab and the notification log, written as the
// frontend mocks show them, idempotent, and read back through the real routes. Needs the frontend checkout.
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { parseEnv } from '../../src/config';
import { schema as s } from '../../src/infra/db';
import { CUSTOMER_MAIL_EVENT_KEYS } from '../../src/modules/platform';
import { demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { seedIdentity } from '../../scripts/seed/identity';
import { seedPlatform } from '../../scripts/seed/platform';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TEST_DATABASE_URL, closeTestDb, resetDb, testDb } from '../support/db';
import { testInstanceEnv } from '../support/env';
import { seedDefaultTemplates } from '../support/notifications';

setDefaultTimeout(60_000);

const config = parseEnv({ NODE_ENV: 'test', DATABASE_URL_TEST: TEST_DATABASE_URL, ...testInstanceEnv() });
const frontendPresent = existsSync(demoStatePath());
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

async function seed() {
  const { db } = await testDb();
  const demo = await loadDemoState();
  return db.transaction(async (tx) => {
    // The migration's own templates are gone after resetDb: put them back, as a migrated database has them.
    await seedDefaultTemplates(tx as never);
    return { identity: await seedIdentity(tx, demo, config), platform: await seedPlatform(tx, demo, config) };
  });
}
const reportOf = (reports: Array<{ table: string }>, table: string) => reports.find((report) => report.table === table);

describe.skipIf(!frontendPresent)('the 12a seed', () => {
  it('writes the six customer emails with the demo’s switches, next to the defaults the migration ships, and nothing twice', async () => {
    const first = await seed();
    expect(reportOf(first.platform, 'notification_templates')).toMatchObject({ inserted: 6, existing: 0 });
    const { db } = await testDb();
    // The four account mails (feature 14b) are default templates of the migrations, not the demo's six.
    const accountMails: readonly string[] = CUSTOMER_MAIL_EVENT_KEYS;
    const customer = (await db.select().from(s.notificationTemplates).orderBy(s.notificationTemplates.id)).filter(
      (row) => row.audience === 'customer' && !accountMails.includes(row.event),
    );
    expect(customer.map((row) => [row.event, row.isActive])).toEqual([
      ['order.received', true],
      ['order.completed', true],
      ['order.failed', true],
      ['support.reply', true],
      ['checkout.abandoned', true],
      ['payment.failed', false],
    ]);
    expect(customer[0]).toMatchObject({
      channel: 'email',
      locale: 'en',
      subject: 'Your order {{orderId}} is confirmed',
    });
    // Rerunning the seed adds nothing.
    const again = (await seed()).platform;
    expect(reportOf(again, 'notification_templates')).toMatchObject({ inserted: 0, existing: 6 });
    expect(reportOf(again, 'notifications')).toMatchObject({ inserted: 0 });
  });

  it('writes the messages behind the 30-day counts (112, 86, 6, 41, 17, 0) and a recent log of 48 to the merchants', async () => {
    const { platform } = await seed();
    expect(reportOf(platform, 'notifications')).toMatchObject({ inserted: 112 + 86 + 6 + 41 + 17 + 48, existing: 0 });
    const owner = await adminWith(t, ['*']);
    const accountMails: readonly string[] = CUSTOMER_MAIL_EVENT_KEYS;
    const templates = (
      (await owner.get('/admin/notification-templates?audience=customer&_sort=id&_order=asc')).body as Array<{
        event: string;
        sentLast30Days: number;
      }>
    ).filter((row) => !accountMails.includes(row.event));
    expect(templates.map((row: { event: string; sentLast30Days: number }) => [row.event, row.sentLast30Days])).toEqual([
      ['order.received', 112],
      ['order.completed', 86],
      ['order.failed', 6],
      ['support.reply', 41],
      ['checkout.abandoned', 17],
      ['payment.failed', 0],
    ]);
  });

  it('lists the recent merchant log newest first with masked recipients, failures with their reason and queued messages', async () => {
    await seed();
    const owner = await adminWith(t, ['*']);
    const res = await owner.get('/admin/notifications?recipientType=client&_start=0&_end=48');
    expect(res.total).toBe(48);
    expect(res.body[0]).toMatchObject({ recipientType: 'client', status: 'sent', error: null });
    const created = res.body.map((row: { createdAt: string }) => row.createdAt);
    expect(created).toEqual([...created].sort().reverse());
    const statuses = res.body.map((row: { status: string }) => row.status);
    expect(statuses.filter((status: string) => status === 'failed')).toHaveLength(7);
    // Every eleventh message (4 of them) is queued; the one that is also a seventh (the 39th) is the failed one.
    expect(statuses.filter((status: string) => status === 'queued')).toHaveLength(3);
    const failed = res.body.filter((row: { status: string }) => row.status === 'failed');
    expect(failed.every((row: { error: string }) => row.error.length > 0)).toBe(true);
    for (const row of res.body) {
      expect(row.recipient, row.recipient).toMatch(row.channel === 'telegram' ? /^@\d\*\*\*$/ : /^.\*\*\*@/);
      expect(row.recipient).not.toMatch(/^[^*]{4,}@/);
    }
  });
});
