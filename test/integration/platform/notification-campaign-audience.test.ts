// Integration tests of the audience preview (feature 23, route 6, plan section 5; decision 064): every segment and filter, `include` and
// `exclude` (a person is `staff` or `account`), the two account groups told apart by the rank (the merchants segment never selects a
// retail account, the customers segment selects retail accounts and guests, marketing skips a retail account without consent), marketing consent, the merchant
// switches, suspended and anonymized people, the SQL twin of `choiceFor`, `count` equal to the pages of each provider, and an answer of
// counts only.
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
    customerAnonymized: await insertCustomer(db, { status: 'anonymized', anonymizedAt: clock.now() }),
  };
  await setMarketingConsent(db, w.customerConsent, true);
  await setMarketingConsent(db, w.customerWithdrawn, true);
  await setMarketingConsent(db, w.customerWithdrawn, false);
  // A switch on with no record proves nothing: the latest record must grant it.
  await db.update(s.clients).set({ marketingOptIn: true }).where(eq(s.clients.id, w.customerJo));
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
  it('counts "everyone": active staff, active accounts of a merchant rank and active retail accounts with a login', async () => {
    const res = await preview({ staff: {}, merchants: {}, customers: { hasAccount: true } });
    // Staff: owner, A, B. Merchants (accounts of a merchant rank): Jo, Vip, NoEmail, Plain, OldSwitch. Retail accounts with a login: Jo, Sa, Consent, Withdrawn.
    expect(res).toEqual({
      total: 12,
      reachable: 12,
      byType: { staff: 3, merchant: 5, retail: 4 },
      byChannel: { inApp: 12, email: 11 },
      excluded: { noConsent: 0, optedOut: 1, noAccount: 0 },
    });
  });

  it('answers counts only: no name, address or id', async () => {
    const res = await owner.post('/admin/notification-campaigns/audience-preview', {
      audience: { include: [{ type: 'account', id: w.customerJo }] },
      channels: ['email'],
      purpose: 'service',
    });
    expect(JSON.stringify(res.body)).not.toContain('@');
    expect(JSON.stringify(res.body)).not.toContain('Test');
  });

  it('filters staff by role', async () => {
    const res = await preview({ staff: { roleIds: [w.roleA] } });
    expect(res.byType).toEqual({ staff: 1, merchant: 0, retail: 0 });
  });

  it('filters merchants by rank and country, and reads a status filter of pending as active (the status no longer exists)', async () => {
    expect((await preview({ merchants: { statuses: ['active', 'pending'] } })).total).toBe(5);
    // Only active accounts are ever reached: a stored filter of pending reads as active and does not make a suspended one reachable.
    expect((await preview({ merchants: { statuses: ['pending'] } })).total).toBe(5);
    expect((await preview({ merchants: { groupIds: [w.groupVip] } })).total).toBe(1);
    expect((await preview({ merchants: { countries: ['JO', 'AE'] } })).total).toBe(2);
  });

  it('the merchants segment never selects a retail account, the customers segment selects retail accounts and guests', async () => {
    // `byType` counts the people who can be reached: of the five merchant ranks one switched the announcement email off.
    const merchants = await preview({ merchants: {} }, ['email']);
    expect(merchants.byType).toEqual({ staff: 0, merchant: 4, retail: 0 });
    // The retail group is every account that holds no merchant rank, a guest included.
    const retail = await preview({ customers: {} }, ['email']);
    expect(retail.byType).toEqual({ staff: 0, merchant: 0, retail: 5 });
    expect(retail.total).toBe(5);
    // An account moved to a merchant rank leaves the customers segment and joins the merchants one, in the same table.
    const { db } = await testDb();
    await db.update(s.clients).set({ groupId: w.groupVip }).where(eq(s.clients.id, w.customerSa));
    expect((await preview({ customers: {} }, ['email'])).byType.retail).toBe(4);
    expect((await preview({ merchants: {} }, ['email'])).byType.merchant).toBe(5);
  });

  it('a marketing campaign skips a retail account without consent and asks nothing of a merchant rank', async () => {
    const retail = await preview({ customers: {} }, ['email'], 'marketing');
    expect(retail).toMatchObject({ total: 1, reachable: 1, excluded: { noConsent: 4 } });
    // Merchant ranks follow their announcement switch, not a consent record.
    const merchants = await preview({ merchants: {} }, ['email'], 'marketing');
    expect(merchants).toMatchObject({ total: 5, reachable: 4, excluded: { noConsent: 0 } });
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
    expect((await preview({ customers: { hasAccount: true } })).total).toBe(4);
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

  it('adds included people (still eligible ones only), each to the group of its rank, and removes excluded people', async () => {
    const res = await preview({
      staff: {},
      include: [
        { type: 'account', id: w.customerSa },
        { type: 'account', id: w.customerSuspended },
        { type: 'account', id: w.customerAnonymized },
        { type: 'account', id: w.merchantJo },
        { type: 'account', id: w.merchantSuspended },
        { type: 'staff', id: w.staffSuspended },
      ],
      exclude: [{ type: 'staff', id: w.staffA }],
    });
    // A person added by hand is one account whatever its rank: the retail account lands in the retail group, the merchant rank in the merchants.
    expect(res.byType).toEqual({ staff: 2, merchant: 1, retail: 1 });
    expect(res.total).toBe(4);
  });

  it('removes an excluded account from whichever group it belongs to, and counts a listed account once', async () => {
    const res = await preview({
      customers: {},
      merchants: {},
      include: [{ type: 'account', id: w.merchantJo }],
      exclude: [
        { type: 'account', id: w.customerSa },
        { type: 'account', id: w.merchantVip },
      ],
    });
    expect(res.byType).toEqual({ staff: 0, merchant: 4, retail: 4 });
  });

  it('refuses a person of the old words client and customer', async () => {
    for (const type of ['client', 'customer']) {
      const refused = await owner.post('/admin/notification-campaigns/audience-preview', {
        audience: { staff: {}, include: [{ type, id: 1 }] },
        channels: ['email'],
        purpose: 'service',
      });
      expect(refused.status, type).toBe(422);
    }
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
      audience: { customers: { countries: ['JO', 'SA'] }, exclude: [{ type: 'account', id: 1 }] },
      purpose: 'service',
    },
    { audience: { staff: { roleIds: [1] }, include: [{ type: 'account', id: 1 }] }, purpose: 'service' },
  ];

  it('count every person that the pages list, for a matrix of specs (one predicate for count, page and member)', async () => {
    const audiences = t.app.get(NotificationAudiences);
    const db = t.app.get(DbService).db;
    for (const { audience, purpose } of SPECS) {
      const spec = zAudienceSpec.parse(audience);
      for (const selection of selectionsOf(spec)) {
        const query: AudienceQuery = { ...selection, purpose, channels: ['in_app', 'email'] };
        const provider = audiences.get(selection.kind);
        const counts = await provider.count(db, query);
        const members = [];
        let afterId = 0;
        for (;;) {
          const page = await provider.page(db, query, afterId, 2);
          members.push(...page);
          if (page.length < 2) break;
          afterId = page.at(-1)!.id;
        }
        expect(members.length, `${selection.kind} ${JSON.stringify(audience)}`).toBe(counts.total);
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
      const member = await audiences.get('merchant').member(t.app.get(DbService).db, 'service', id);
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
    expect(await audiences.get('merchant').member(db, 'service', w.merchantSuspended)).toBeUndefined();
    expect(await audiences.get('merchant').member(db, 'service', w.merchantJo)).toMatchObject({ inApp: true });
    expect(await audiences.get('retail').member(db, 'service', w.customerAnonymized)).toBeUndefined();
    expect(await audiences.get('retail').member(db, 'service', w.customerSuspended)).toBeUndefined();
    expect(await audiences.get('retail').member(db, 'marketing', w.customerWithdrawn)).toBeUndefined();
    expect(await audiences.get('retail').member(db, 'marketing', w.customerConsent)).toMatchObject({ email: true });
    expect(await audiences.get('retail').member(db, 'service', 99_999_999)).toBeUndefined();
    const member = await audiences.get('retail').member(db, 'service', w.customerSa);
    expect(member).toMatchObject({ inApp: true, email: true });
    expect(member).not.toHaveProperty('locale');
    // A guest has no inbox: reachable by email, not in the app.
    expect(await audiences.get('retail').member(db, 'service', w.guest)).toMatchObject({ inApp: false, email: true });
  });

  it('keeps the two account groups apart: a merchant rank is no member of the retail group and a retail account none of the merchants', async () => {
    const audiences = t.app.get(NotificationAudiences);
    const db = t.app.get(DbService).db;
    expect(await audiences.get('retail').member(db, 'service', w.merchantJo)).toBeUndefined();
    expect(await audiences.get('merchant').member(db, 'service', w.customerSa)).toBeUndefined();
    expect(audiences.kinds().sort()).toEqual(['merchant', 'retail', 'staff']);
  });
});

describe('an account whose address was never proven (decision 053)', () => {
  it('no campaign reaches a retail account or a guest whose address was never proven', async () => {
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
      accountId: payer,
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
    expect(service.byType.retail).toBe(baseline.service.byType.retail + 2);
    const marketing = await preview({ customers: {} }, ['email'], 'marketing');
    expect(marketing.total).toBe(baseline.marketing.total + 2);
    // Listed by hand, the unproven one still does not count (an include never adds a person the audience refuses).
    const listed = await preview({ include: [{ type: 'account', id: never }] }, ['email'], 'service');
    expect(listed.total).toBe(0);

    // The page and the member check say the same.
    const audiences = t.app.get(NotificationAudiences);
    const dbx = t.app.get(DbService).db;
    for (const purpose of ['service', 'marketing'] as const) {
      expect(await audiences.get('retail').member(dbx, purpose, never), purpose).toBeUndefined();
      expect(await audiences.get('retail').member(dbx, purpose, verified), purpose).toMatchObject({ email: true });
      expect(await audiences.get('retail').member(dbx, purpose, payer), purpose).toMatchObject({ email: true });
    }
    // Once the typed address is proven the recorded answer counts.
    await db
      .update(s.clients)
      .set({ emailVerifiedAt: new Date(clock.nowMs()) })
      .where(eq(s.clients.id, never));
    expect(await audiences.get('retail').member(dbx, 'marketing', never)).toMatchObject({ email: true });
  });
});
