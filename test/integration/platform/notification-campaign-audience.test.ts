// Integration tests of the audience preview (feature 23, route 6, plan section 5): every segment and filter, `include` and `exclude`,
// marketing consent, the merchant switches, suspended, pending and anonymized people, the SQL twin of `choiceFor`,
// `count` equal to the pages of each provider, and an answer of counts only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DbService, schema as s } from '@src/infra/db';
import {
  BROADCAST_EVENTS,
  type AudienceQuery,
  type CampaignChannel,
  NotificationAudiences,
  choiceFor,
  selectionsOf,
  zAudienceSpec,
} from '@src/modules/platform';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertMerchant, insertRole, insertStaff } from '../../support/auth';
import { insertCategory, insertService } from '../../support/catalog';
import { insertCustomer, setMarketingConsent } from '../../support/campaigns';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertCurrency } from '../../support/storefront';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let owner: AdminApi;

/** The people of every test, by role. */
interface World {
  readonly roleA: number;
  readonly roleB: number;
  readonly staffA: number;
  readonly staffB: number;
  readonly staffSuspended: number;
  readonly groupVip: number;
  readonly merchantJo: number;
  readonly merchantVip: number;
  readonly merchantPending: number;
  readonly merchantSuspended: number;
  readonly merchantNoEmail: number;
  readonly merchantPlain: number;
  readonly merchantOldSwitch: number;
  readonly customerJo: number;
  readonly customerSa: number;
  readonly guest: number;
  readonly customerConsent: number;
  readonly customerWithdrawn: number;
  readonly customerSuspended: number;
  readonly customerAnonymized: number;
}
let w: World;

const announcement = (prefs: Record<string, unknown>) => ({ events: { 'broadcast.announcement': prefs } });

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  owner = await adminWith(t, ['*']);
  const { db } = await testDb();
  const roleA = await insertRole(db, ['orders:read']);
  const roleB = await insertRole(db, ['clients:read']);
  const merchantJo = await insertMerchant(db, { country: 'JO' });
  // insertMerchant takes the first group it finds: pin the standard one so no merchant lands in VIP by chance.
  const [{ groupId }] = (await db.select({ groupId: s.clients.groupId }).from(s.clients)) as [{ groupId: number }];
  const [vip] = await db.insert(s.clientGroups).values({ name: 'VIP' }).returning({ id: s.clientGroups.id });
  const merchant = (values: Parameters<typeof insertMerchant>[1] = {}) => insertMerchant(db, { groupId, ...values });
  w = {
    roleA,
    roleB,
    staffA: await insertStaff(db, roleA),
    staffB: await insertStaff(db, roleB),
    staffSuspended: await insertStaff(db, roleA, { status: 'suspended' }),
    groupVip: vip!.id,
    merchantJo,
    merchantVip: await merchant({ groupId: vip!.id, country: 'AE' }),
    merchantPending: await merchant({ status: 'pending' }),
    merchantSuspended: await merchant({ status: 'suspended' }),
    merchantNoEmail: await merchant({ notificationPrefs: announcement({ email: false }) }),
    merchantPlain: await merchant(),
    // A Telegram switch that an older save stored: it is ignored, so the merchant is a plain one.
    merchantOldSwitch: await merchant({ notificationPrefs: announcement({ telegram: false }) }),
    customerJo: await insertCustomer(db, { country: 'JO' }),
    customerSa: await insertCustomer(db, { country: 'SA' }),
    guest: await insertCustomer(db, { hasAccount: false }),
    customerConsent: await insertCustomer(db),
    customerWithdrawn: await insertCustomer(db),
    customerSuspended: await insertCustomer(db, { status: 'suspended' }),
    customerAnonymized: await insertCustomer(db, { status: 'anonymized' }),
  };
  await setMarketingConsent(db, w.customerConsent, true);
  await setMarketingConsent(db, w.customerWithdrawn, true);
  await setMarketingConsent(db, w.customerWithdrawn, false);
  // A switch on with no record proves nothing: the latest record must grant it.
  await db.update(s.customers).set({ marketingOptIn: true }).where(eq(s.customers.id, w.customerJo));
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

async function preview(audience: unknown, channels: CampaignChannel[] = ['in_app', 'email'], purpose = 'service') {
  const res = await owner.post('/admin/notification-campaigns/audience-preview', { audience, channels, purpose });
  if (res.status !== 200) throw new Error(`${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

describe('POST /admin/notification-campaigns/audience-preview', () => {
  it('counts "everyone": active staff, active merchants and active customers with an account', async () => {
    const res = await preview({ staff: {}, merchants: {}, customers: { hasAccount: true } });
    // Staff: owner, A, B. Merchants: Jo, Vip, NoEmail, Plain, OldSwitch. Customers with an account: Jo, Sa, Consent, Withdrawn.
    expect(res).toEqual({
      total: 12,
      reachable: 12,
      byType: { staff: 3, client: 5, customer: 4 },
      byChannel: { inApp: 12, email: 11 },
      excluded: { noConsent: 0, optedOut: 1, noAccount: 0 },
    });
  });

  it('answers counts only: no name, address or id', async () => {
    const res = await owner.post('/admin/notification-campaigns/audience-preview', {
      audience: { include: [{ type: 'customer', id: w.customerJo }] },
      channels: ['email'],
      purpose: 'service',
    });
    expect(JSON.stringify(res.body)).not.toContain('@');
    expect(JSON.stringify(res.body)).not.toContain('Test');
  });

  it('filters staff by role', async () => {
    const res = await preview({ staff: { roleIds: [w.roleA] } });
    expect(res.byType).toEqual({ staff: 1, client: 0, customer: 0 });
  });

  it('filters merchants by status, group and country, and counts pending merchants only when asked', async () => {
    expect((await preview({ merchants: { statuses: ['active', 'pending'] } })).total).toBe(6);
    expect((await preview({ merchants: { statuses: ['pending'] } })).total).toBe(1);
    expect((await preview({ merchants: { groupIds: [w.groupVip] } })).total).toBe(1);
    expect((await preview({ merchants: { countries: ['JO', 'AE'] } })).total).toBe(2);
  });

  it('honours the merchant announcement email switch, and ignores a Telegram switch that an older save stored', async () => {
    const res = await preview({ merchants: {} }, ['email']);
    // The merchant who switched email off is in the audience but not reachable.
    expect(res).toMatchObject({
      total: 5,
      reachable: 4,
      byChannel: { inApp: 0, email: 4 },
      excluded: { optedOut: 1, noAccount: 0 },
    });
    expect(res.byChannel).not.toHaveProperty('telegram');
  });

  it('filters customers by account and country, and has no language filter any more', async () => {
    expect((await preview({ customers: {} })).total).toBe(5);
    expect((await preview({ customers: { hasAccount: false } })).total).toBe(1);
    expect((await preview({ customers: { countries: ['SA'] } })).total).toBe(1);
    expect((await preview({ customers: { countries: ['SA', 'JO'] } })).total).toBe(2);
    // Decision 039: `locales` is an unknown key of the strict segment, and the answer carries no `byLocale`.
    expect(await preview({ customers: {} })).not.toHaveProperty('byLocale');
    const refused = await owner.post('/admin/notification-campaigns/audience-preview', {
      audience: { customers: { locales: ['en'] } },
      channels: ['email'],
      purpose: 'service',
    });
    expect(refused.status).toBe(422);
  });

  it('counts a guest in the total but not as reachable by the in-app channel alone', async () => {
    const res = await preview({ customers: { hasAccount: false } }, ['in_app']);
    expect(res).toMatchObject({ total: 1, reachable: 0, excluded: { noAccount: 1 } });
  });

  it('keeps only customers whose latest marketing record grants it, for a marketing purpose', async () => {
    const res = await preview({ customers: {} }, ['email'], 'marketing');
    expect(res).toMatchObject({ total: 1, reachable: 1, excluded: { noConsent: 4 } });
    const service = await preview({ customers: {} }, ['email'], 'service');
    expect(service.excluded.noConsent).toBe(0);
  });

  it('adds included people (still eligible ones only) and removes excluded people', async () => {
    const res = await preview({
      staff: {},
      include: [
        { type: 'customer', id: w.customerSa },
        { type: 'customer', id: w.customerSuspended },
        { type: 'customer', id: w.customerAnonymized },
        { type: 'client', id: w.merchantPending },
        { type: 'client', id: w.merchantSuspended },
        { type: 'staff', id: w.staffSuspended },
      ],
      exclude: [{ type: 'staff', id: w.staffA }],
    });
    expect(res.byType).toEqual({ staff: 2, client: 1, customer: 1 });
  });

  it('refuses an audience that targets nobody, naming the field, and the retired Telegram channel', async () => {
    const empty = await owner.post('/admin/notification-campaigns/audience-preview', {
      audience: {},
      channels: ['email'],
      purpose: 'service',
    });
    expect(empty.status).toBe(422);
    expect(empty.body.errors.map((e: { field: string }) => e.field)).toEqual(['audience']);
    const telegram = await owner.post('/admin/notification-campaigns/audience-preview', {
      audience: { staff: {} },
      channels: ['telegram'],
      purpose: 'service',
    });
    expect(telegram.status).toBe(422);
    expect(telegram.body.errors[0].field).toMatch(/^channels/);
  });

  it('writes nothing', async () => {
    const { db } = await testDb();
    const before = (await db.select().from(s.auditLogs)).length;
    await preview({ staff: {} });
    expect((await db.select().from(s.auditLogs)).length).toBe(before);
  });
});

describe('the providers', () => {
  const SPECS: Array<{ audience: unknown; purpose: 'service' | 'marketing' }> = [
    { audience: { staff: {}, merchants: {}, customers: {} }, purpose: 'service' },
    {
      audience: { merchants: { statuses: ['active', 'pending'] }, customers: { hasAccount: true } },
      purpose: 'marketing',
    },
    {
      audience: { customers: { countries: ['JO', 'SA'] }, exclude: [{ type: 'customer', id: 1 }] },
      purpose: 'service',
    },
    { audience: { staff: { roleIds: [1] }, include: [{ type: 'client', id: 1 }] }, purpose: 'service' },
  ];

  it('count every person that the pages list, for a matrix of specs (one predicate for count, page and member)', async () => {
    const audiences = t.app.get(NotificationAudiences);
    const db = t.app.get(DbService).db;
    for (const { audience, purpose } of SPECS) {
      const spec = zAudienceSpec.parse(audience);
      for (const selection of selectionsOf(spec)) {
        const query: AudienceQuery = { ...selection, purpose, channels: ['in_app', 'email'] };
        const provider = audiences.get(selection.type);
        const counts = await provider.count(db, query);
        const members = [];
        let afterId = 0;
        for (;;) {
          const page = await provider.page(db, query, afterId, 2);
          members.push(...page);
          if (page.length < 2) break;
          afterId = page.at(-1)!.id;
        }
        expect(members.length, `${selection.type} ${JSON.stringify(audience)}`).toBe(counts.total);
        expect(members.filter((m) => m.email).length).toBe(counts.email);
        expect(members.filter((m) => m.inApp).length).toBe(counts.inApp);
        for (const member of members) expect(await provider.member(db, purpose, member.id)).toEqual(member);
      }
    }
  });

  it('keeps the merchant switches equal to choiceFor for every kind of stored preference', async () => {
    const definition = BROADCAST_EVENTS.find((event) => event.audience === 'merchant')!;
    const matrix: Array<Record<string, unknown> | null> = [
      null,
      {},
      { events: 'nope' },
      { events: { 'broadcast.announcement': 'nope' } },
      announcement({}),
      announcement({ email: true, telegram: true }),
      announcement({ email: false, telegram: false }),
      announcement({ email: 'false', telegram: 0 }),
      announcement({ email: false }),
      announcement({ telegram: false }),
    ];
    const { db } = await testDb();
    const audiences = t.app.get(NotificationAudiences);
    for (const prefs of matrix) {
      const id = await insertMerchant(db, { notificationPrefs: prefs ?? {} });
      const member = await audiences.get('client').member(t.app.get(DbService).db, 'service', id);
      const choice = choiceFor(definition, prefs ?? {});
      expect(member, JSON.stringify(prefs)).toMatchObject({ email: choice.email });
      expect(member).not.toHaveProperty('telegram');
      await db.delete(s.clients).where(eq(s.clients.id, id));
    }
  });

  it('answers no member for a gone, suspended, anonymized or (marketing) unconsenting person', async () => {
    const audiences = t.app.get(NotificationAudiences);
    const db = t.app.get(DbService).db;
    expect(await audiences.get('staff').member(db, 'service', w.staffSuspended)).toBeUndefined();
    expect(await audiences.get('client').member(db, 'service', w.merchantSuspended)).toBeUndefined();
    expect(await audiences.get('client').member(db, 'service', w.merchantPending)).toMatchObject({ inApp: true });
    expect(await audiences.get('customer').member(db, 'service', w.customerAnonymized)).toBeUndefined();
    expect(await audiences.get('customer').member(db, 'marketing', w.customerWithdrawn)).toBeUndefined();
    expect(await audiences.get('customer').member(db, 'marketing', w.customerConsent)).toMatchObject({ email: true });
    expect(await audiences.get('customer').member(db, 'service', 99_999_999)).toBeUndefined();
    const member = await audiences.get('customer').member(db, 'service', w.customerSa);
    expect(member).toMatchObject({ inApp: true, email: true });
    expect(member).not.toHaveProperty('locale');
  });
});

describe('a customer whose address was never proven (decision 053)', () => {
  it('no campaign reaches a customer whose address was never proven', async () => {
    const { db } = await testDb();
    const baseline = {
      service: await preview({ customers: {} }, ['email'], 'service'),
      marketing: await preview({ customers: {} }, ['email'], 'marketing'),
    };
    // Three guests who all agreed to marketing: one typed an address that nobody confirmed, one used a sign-in link, one paid a checkout.
    const never = await insertCustomer(db, { hasAccount: false, emailVerifiedAt: null });
    const verified = await insertCustomer(db, { hasAccount: false });
    const payer = await insertCustomer(db, { hasAccount: false, emailVerifiedAt: null });
    for (const id of [never, verified, payer]) await setMarketingConsent(db, id, true);
    await insertCurrency(db, { code: 'USD' });
    const serviceId = await insertService(db, await insertCategory(db));
    await db.insert(s.checkoutSessions).values({
      token: 'paid-audience-token-0001',
      customerId: payer,
      email: 'payer@mail.example',
      serviceId,
      currency: 'USD',
      fxRate: '1',
      netAmount: '4.7900',
      grossAmount: '4.7900',
      utm: {},
      status: 'paid',
      expiresAt: new Date(clock.nowMs() + 30 * 60_000),
    });

    // The counts include the two proven guests only, for a service campaign and for a marketing one.
    const service = await preview({ customers: {} }, ['email'], 'service');
    expect(service.total).toBe(baseline.service.total + 2);
    expect(service.byType.customer).toBe(baseline.service.byType.customer + 2);
    const marketing = await preview({ customers: {} }, ['email'], 'marketing');
    expect(marketing.total).toBe(baseline.marketing.total + 2);
    // Listed by hand, the unproven one still does not count (an include never adds a person the audience refuses).
    const listed = await preview({ include: [{ type: 'customer', id: never }] }, ['email'], 'service');
    expect(listed.total).toBe(0);

    // The page and the member check say the same.
    const audiences = t.app.get(NotificationAudiences);
    const dbx = t.app.get(DbService).db;
    for (const purpose of ['service', 'marketing'] as const) {
      expect(await audiences.get('customer').member(dbx, purpose, never), purpose).toBeUndefined();
      expect(await audiences.get('customer').member(dbx, purpose, verified), purpose).toMatchObject({ email: true });
      expect(await audiences.get('customer').member(dbx, purpose, payer), purpose).toMatchObject({ email: true });
    }
    // Once the typed address is proven the recorded answer counts.
    await db
      .update(s.customers)
      .set({ emailVerifiedAt: new Date(clock.nowMs()) })
      .where(eq(s.customers.id, never));
    expect(await audiences.get('customer').member(dbx, 'marketing', never)).toMatchObject({ email: true });
  });
});
