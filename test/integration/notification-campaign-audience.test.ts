// Integration tests of the audience preview (feature 23, route 6, plan section 5): every segment and filter, `include` and `exclude`,
// marketing consent, the merchant switches and linked chats, suspended, pending and anonymized people, the SQL twin of `choiceFor`,
// `count` equal to the pages of each provider, and an answer of counts only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DbService, schema as s } from '../../src/infra/db';
import {
  BROADCAST_EVENTS,
  type AudienceQuery,
  type CampaignChannel,
  NotificationAudiences,
  choiceFor,
  selectionsOf,
  zAudienceSpec,
} from '../../src/modules/platform';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant, insertRole, insertStaff } from '../support/auth';
import { insertCustomer, setMarketingConsent } from '../support/campaigns';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';

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
  readonly merchantChat: number;
  readonly merchantChatOff: number;
  readonly customerEn: number;
  readonly customerAr: number;
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
    merchantChat: await merchant({ telegramChatId: '1001' }),
    merchantChatOff: await merchant({
      telegramChatId: '1002',
      notificationPrefs: announcement({ telegram: false }),
    }),
    customerEn: await insertCustomer(db, { country: 'JO' }),
    customerAr: await insertCustomer(db, { locale: 'ar', country: 'SA' }),
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
  await db.update(s.customers).set({ marketingOptIn: true }).where(eq(s.customers.id, w.customerEn));
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
    // Staff: owner, A, B. Merchants: Jo, Vip, NoEmail, Chat, ChatOff. Customers with an account: En, Ar, Consent, Withdrawn.
    expect(res).toEqual({
      total: 12,
      reachable: 12,
      byType: { staff: 3, client: 5, customer: 4 },
      byChannel: { inApp: 12, email: 11, telegram: 0 },
      byLocale: { en: 11, ar: 1 },
      excluded: { noConsent: 0, optedOut: 1, noTelegram: 0, noAccount: 0 },
    });
  });

  it('answers counts only: no name, address or id', async () => {
    const res = await owner.post('/admin/notification-campaigns/audience-preview', {
      audience: { include: [{ type: 'customer', id: w.customerEn }] },
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

  it('honours the merchant announcement switches and linked chats for email and Telegram', async () => {
    const res = await preview({ merchants: {} }, ['email', 'telegram']);
    // The merchant who switched email off and has no chat is in the audience but reachable by neither channel.
    expect(res).toMatchObject({
      total: 5,
      reachable: 4,
      byChannel: { inApp: 0, email: 4, telegram: 1 },
      excluded: { optedOut: 1, noTelegram: 4, noAccount: 0 },
    });
    const telegramOnly = await preview({ merchants: {} }, ['telegram']);
    expect(telegramOnly).toMatchObject({ total: 5, reachable: 1 });
  });

  it('filters customers by account, country and language', async () => {
    expect((await preview({ customers: {} })).total).toBe(5);
    expect((await preview({ customers: { hasAccount: false } })).total).toBe(1);
    expect((await preview({ customers: { countries: ['SA'] } })).byLocale).toEqual({ en: 0, ar: 1 });
    expect((await preview({ customers: { locales: ['ar'] } })).total).toBe(1);
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
        { type: 'customer', id: w.customerAr },
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

  it('refuses an audience that targets nobody and Telegram without merchants, naming the field', async () => {
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
    expect(telegram.body.errors.map((e: { field: string }) => e.field)).toEqual(['channels']);
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
    { audience: { customers: { locales: ['ar', 'en'] }, exclude: [{ type: 'customer', id: 1 }] }, purpose: 'service' },
    { audience: { staff: { roleIds: [1] }, include: [{ type: 'client', id: 1 }] }, purpose: 'service' },
  ];

  it('count every person that the pages list, for a matrix of specs (one predicate for count, page and member)', async () => {
    const audiences = t.app.get(NotificationAudiences);
    const db = t.app.get(DbService).db;
    for (const { audience, purpose } of SPECS) {
      const spec = zAudienceSpec.parse(audience);
      for (const selection of selectionsOf(spec)) {
        const query: AudienceQuery = { ...selection, purpose, channels: ['in_app', 'email', 'telegram'] };
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
        expect(members.filter((m) => m.telegram).length).toBe(counts.telegram);
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
      for (const chat of [null, '777']) {
        const id = await insertMerchant(db, { notificationPrefs: prefs ?? {}, telegramChatId: chat });
        const member = await audiences.get('client').member(t.app.get(DbService).db, 'service', id);
        const choice = choiceFor(definition, prefs ?? {});
        expect(member, JSON.stringify(prefs)).toMatchObject({
          email: choice.email,
          telegram: choice.telegram && chat !== null,
        });
        await db.delete(s.clients).where(eq(s.clients.id, id));
      }
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
    expect(await audiences.get('customer').member(db, 'service', w.customerAr)).toMatchObject({ locale: 'ar' });
  });
});
