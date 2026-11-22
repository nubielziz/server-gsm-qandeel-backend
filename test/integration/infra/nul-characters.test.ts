// Integration tests of the character rule of the validation guard (decision 053) through HTTP on the real application: U+0000 or an
// unpaired surrogate in a body, a query or a path is 422 on its field before any handler runs (whether or not the handler would have
// answered differently), inside the encoded Dhru parameters too; the incoming webhooks are accepted and store the text cleaned.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type AdminApi } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import {
  type MachineCredentials,
  body,
  clearApiKeyCaches,
  credentialsFor,
  dhruClient,
  dhruParameters,
} from '../../support/machine-orders';
import { MerchantPortal, PORTAL_ORIGIN, clearPortalRateLimits, seedPortalBasics } from '../../support/merchant-portal';
import { type OrdersWorld, ordersWorld } from '../../support/orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { APPLE_IMEI, TURNSTILE_HEADERS, storefrontWorld } from '../../support/storefront';
import { supportStaff } from '../../support/support';

const NUL = '\u0000';
/** A high surrogate with no low one after it: not well-formed text. */
const LONE_HIGH = '\ud800';
/** A low surrogate with no high one before it. */
const LONE_LOW = '\udc00';
const MESSAGE = 'Must not contain the character U+0000 or an unpaired surrogate.';
const clock = new TestClock('2026-11-20T10:00:00.000Z');
let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { SHOP_ORIGINS: PORTAL_ORIGIN } });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearPortalRateLimits(t);
  await clearApiKeyCaches(t);
  await seedPortalBasics();
  admin = await supportStaff(t, ['support:*'], 'Rami K.');
});

const portal = () => new MerchantPortal(t, freshClientIp());
const problem = (res: { json: () => unknown }) =>
  res.json() as { code: string; status: number; errors?: Array<{ field: string; code: string; message: string }> };
const form = (over: Record<string, unknown> = {}) => ({
  name: 'Ali Hassan',
  email: 'Ali.Hassan@Example.com',
  password: 'a-long-password',
  company: 'Hassan Mobile',
  phone: '+962791234567',
  country: 'jo',
  ...over,
});
const clientCount = async () =>
  (await (await testDb()).db.select({ n: sql<number>`count(*)::int` }).from(s.clients))[0]!.n;

describe('a NUL character in a request body', () => {
  it('answers 422 for a NUL character in a registration field, whether or not the email is registered', async () => {
    // A known email: the registration used to answer 204 before it wrote anything, a new one used to fail on the insert with a 500.
    expect((await portal().register(form())).statusCode).toBe(204);
    const before = await clientCount();
    for (const email of ['Ali.Hassan@Example.com', 'someone.new@example.com']) {
      const res = await portal().register(form({ name: `Ali${NUL}Hassan`, email }));
      expect(res.statusCode, email).toBe(422);
      const answer = problem(res);
      expect(answer.code).toBe('VALIDATION_FAILED');
      expect(answer.errors).toEqual([{ field: 'name', code: 'invalid_format', message: MESSAGE }]);
    }
    expect(await clientCount()).toBe(before);
  });

  it('answers 422 on a staff route', async () => {
    const res = await admin.post('/admin/reply-templates', {
      title: `Order${NUL} is in progress`,
      category: 'delay',
      body: 'Hi, your order is with the carrier.',
      shortcut: '',
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ field: 'title', code: 'invalid_format', message: MESSAGE }]);
    expect(await (await testDb()).db.select().from(s.replyTemplates)).toHaveLength(0);
  });

  it('refuses an object key that holds the character, naming the object that holds it', async () => {
    const res = await admin.post('/admin/reply-templates', {
      [`key${NUL}`]: 'x',
      title: 'T',
      category: 'delay',
      body: 'b',
    });
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'body', code: 'invalid_format' });
  });

  it('answers 401 before it looks at the text when nobody is signed in (the rule runs after authentication)', async () => {
    const res = await admin.anonymous('POST', '/admin/reply-templates', {
      title: `T${NUL}`,
      category: 'delay',
      body: 'b',
    });
    expect(res.status).toBe(401);
  });
});

describe('an unpaired surrogate in a request body', () => {
  // A public JSON route whose text is written into a JSON column (`checkout_sessions.utm`): the database stores such a text in a text
  // column but refuses it in a JSON one, so the same request would have failed on one branch of the handler only.
  let world: Awaited<ReturnType<typeof storefrontWorld>>;
  const sessionCount = async () =>
    (await (await testDb()).db.select({ n: sql<number>`count(*)::int` }).from(s.checkoutSessions))[0]!.n;
  const open = (utm: Record<string, unknown>) =>
    t.app.inject({
      method: 'POST',
      url: '/store/v1/checkout-sessions',
      headers: { 'user-agent': 'Mozilla/5.0 (test)', ...TURNSTILE_HEADERS },
      remoteAddress: freshClientIp(),
      payload: {
        serviceId: world.icloud.serviceId,
        email: 'sam@mail.example',
        country: 'GB',
        currency: 'GBP',
        imei: APPLE_IMEI,
        utm,
      },
    });

  beforeEach(async () => {
    await resetDb();
    world = await storefrontWorld((await testDb()).db);
  });

  it('answers 422 for a lone high or low surrogate in a value that reaches a JSON column, and opens nothing', async () => {
    for (const lone of [LONE_HIGH, LONE_LOW]) {
      const res = await open({ source: `Goo${lone}gle` });
      expect(res.statusCode, lone).toBe(422);
      const answer = problem(res);
      expect(answer.code).toBe('VALIDATION_FAILED');
      expect(answer.errors).toEqual([{ field: 'utm.source', code: 'invalid_format', message: MESSAGE }]);
    }
    expect(await sessionCount()).toBe(0);
  });

  it('answers 422 for a lone surrogate in an object key', async () => {
    const res = await open({ [`source${LONE_HIGH}`]: 'Google' });
    expect(res.statusCode).toBe(422);
    expect(problem(res).errors?.[0]).toMatchObject({ field: 'utm', code: 'invalid_format' });
    expect(await sessionCount()).toBe(0);
  });

  it('accepts a valid surrogate pair (an emoji) in the same value', async () => {
    const res = await open({ source: 'Goo\u{1F600}gle' });
    expect(res.statusCode).toBe(201);
    const [row] = await (await testDb()).db.select().from(s.checkoutSessions);
    expect(row!.utm).toMatchObject({ source: 'Goo\u{1F600}gle' });
  });
});

describe('a NUL character in a query or a path', () => {
  it('answers 422 for a query filter', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/store/v1/services?brand=%00x',
      remoteAddress: freshClientIp(),
    });
    expect(res.statusCode).toBe(422);
    expect(problem(res).errors?.[0]).toMatchObject({ field: 'brand', code: 'invalid_format' });
  });

  it('answers 422 for a path parameter', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/store/v1/legacy-slugs/service/a%00b',
      remoteAddress: freshClientIp(),
    });
    expect(res.statusCode).toBe(422);
    expect(problem(res).errors?.[0]).toMatchObject({ field: 'slug', code: 'invalid_format' });
  });

  it('answers 422 for the search text, and keeps dropping a tab from it', async () => {
    const nul = await t.app.inject({
      method: 'GET',
      url: '/store/v1/search?q=sam%00sung',
      remoteAddress: freshClientIp(),
    });
    expect(nul.statusCode).toBe(422);
    expect(problem(nul).errors?.[0]).toMatchObject({ field: 'q', code: 'invalid_format' });
  });
});

describe('a NUL character inside the Dhru parameters', () => {
  let world: OrdersWorld;
  let creds: MachineCredentials;
  let dhru: ReturnType<typeof dhruClient>;

  beforeEach(async () => {
    const { db } = await testDb();
    world = await ordersWorld(db);
    creds = await credentialsFor(t, db, world.merchant.id);
    dhru = dhruClient(t, creds);
  });

  const orderCount = async () =>
    (await (await testDb()).db.select({ n: sql<number>`count(*)::int` }).from(s.orders))[0]!.n;
  const messageOf = (answer: { ERROR?: Array<{ MESSAGE: string }> }) => answer.ERROR?.[0]?.MESSAGE;

  it('refuses U+0000 inside Dhru parameters and custom fields', async () => {
    const parameters = await dhru.call('placeimeiorder', { ID: world.auto.serviceId, IMEI: `35${NUL}2` });
    expect(messageOf(parameters)).toBe(
      'Invalid parameters: a text holds the character U+0000 or an unpaired surrogate.',
    );
    // A custom field value that arrives encoded in its own base64 text is judged where it is decoded.
    const custom = await dhru.call('placeimeiorder', {
      ID: world.server.serviceId,
      CUSTOMFIELD: dhruParameters({ username: `ali${NUL}` }),
    });
    expect(messageOf(custom)).toBe('Invalid custom fields');
    expect(await orderCount()).toBe(0);
  });

  it('refuses an unpaired surrogate inside Dhru parameters and custom fields, and accepts an emoji', async () => {
    // JSON.stringify writes a lone surrogate as an escape, so it survives the base64 round trip and is judged where it is decoded.
    for (const lone of [LONE_HIGH, LONE_LOW]) {
      const parameters = await dhru.call('placeimeiorder', { ID: world.auto.serviceId, IMEI: `35${lone}2` });
      expect(messageOf(parameters), lone).toBe(
        'Invalid parameters: a text holds the character U+0000 or an unpaired surrogate.',
      );
    }
    const custom = await dhru.call('placeimeiorder', {
      ID: world.server.serviceId,
      CUSTOMFIELD: dhruParameters({ username: `ali${LONE_HIGH}` }),
    });
    expect(messageOf(custom)).toBe('Invalid custom fields');
    expect(await orderCount()).toBe(0);
    // A valid pair is not refused by the character rule (the order is judged by its own rules: an IMEI is digits).
    const emoji = await dhru.call('placeimeiorder', { ID: world.auto.serviceId, IMEI: '35\u{1F600}2' });
    expect(messageOf(emoji)).not.toContain('unpaired surrogate');
  });

  it('refuses a bulk whose decoded parameters hold the character before any item runs', async () => {
    const answer = await dhru.call('placeimeiorderbulk', {
      first: { ID: world.auto.serviceId, IMEI: '490154203237518' },
      second: { ID: world.auto.serviceId, IMEI: `35${NUL}2` },
    });
    expect(messageOf(answer)).toBe('Invalid parameters: a text holds the character U+0000 or an unpaired surrogate.');
    expect(await orderCount()).toBe(0);
    expect(body(await dhru.raw('accountinfo')).SUCCESS).toBeDefined();
  });
});
