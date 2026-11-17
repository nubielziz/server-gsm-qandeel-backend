// Arabic text that people and suppliers supply is data, and it keeps working after the language is gone (decision 039, group C,
// plan 9.5): the system has one language, English, but a name on an invoice, a ticket message, a supplier's service name or a
// note on a wallet line is shown, exported and sent exactly as it was typed. This file is the protection of the parts that have no
// test of their own: CSV exports (critic G5), plain-text mails and Telegram (G6), supplier service names on every surface that lists
// them (G4) and a ticket message through the store and staff routes. PDF shaping, upload names, slugs, IMEI digits and the search
// have their own tests (`pdf-renderer.spec.ts`, `storage.test.ts`, `slug.spec.ts`, `golden.test.ts`, ...). Real Postgres and Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { schema as s } from '../../src/infra/db';
import { deposit, postTransaction } from '../../src/modules/money';
import { MaintenanceService, OutboxService } from '../../src/modules/platform';
import { TICKET_MAIL_EVENT, TicketMailProcessor } from '../../src/modules/support';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import {
  body,
  clearApiKeyCaches,
  credentialsFor,
  dhruClient,
  v1Client,
  type MachineCredentials,
} from '../support/machine-orders';
import { mailbox, telegramOutbox } from '../support/notifications';
import { IMEIS, insertOrderRow, ordersWorld, portalFor, type OrdersWorld } from '../support/orders';
import { insertWalletMerchant } from '../support/money';
import { freshClientIp } from '../support/pipeline-routes';
import { insertRetailPrice, listingWorld, TURNSTILE_HEADERS } from '../support/storefront';
import {
  clearTicketEmailLimits,
  insertClient,
  insertCustomer,
  insertSupportMessage,
  insertSupportTicket,
  seedSupportTemplates,
  supportStaff,
} from '../support/support';

/** A person's name and a note, as typed on an Arabic keyboard (digits and the Arabic comma included). */
const NAME = 'محمد علي';
const NOTE = 'تم الدفع بتاريخ ٢٠٢٦/١١/٠٧، شكراً لكم';
/** A supplier's service name that mixes Latin and Arabic script (one of the owner's 1142 real services), and one with no Latin letter. */
const MIXED_SERVICE = 'INVOICES ICLOUD BY REMOVE ICLOUD - فواتير فك ايكلاود';
const ARABIC_SERVICE = 'فـــورمــات تــاب الــمــدارس';
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const clock = new TestClock('2026-11-08T12:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    clock,
    env: { TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token', TELEGRAM_BOT_USERNAME: 'gsm_test_bot' },
  });
});
beforeEach(async () => {
  clock.set('2026-11-08T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  await clearTicketEmailLimits(t);
  await t.app.get(MaintenanceService).invalidate();
  mailbox(t).reset();
  telegramOutbox(t).reset();
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** True when the bytes of a CSV answer hold `text` encoded as UTF-8, and the file starts with no byte order mark. */
function holdsUtf8(raw: Buffer, text: string): boolean {
  return raw.includes(Buffer.from(text, 'utf8')) && !raw.subarray(0, 3).equals(UTF8_BOM);
}

describe('CSV exports carry text as typed (critic G5)', () => {
  let world: OrdersWorld;
  beforeEach(async () => {
    world = await ordersWorld((await testDb()).db);
    await (
      await testDb()
    ).db
      .update(s.services)
      .set({ name: MIXED_SERVICE })
      .where(eq(s.services.id, world.auto.serviceId));
  });

  it("the staff order export: a customer's Arabic name and a supplier's Arabic service name come back byte for byte, as UTF-8", async () => {
    const { db, auto } = world;
    const [customer] = await db
      .insert(s.customers)
      .values({ email: 'm@example.com', name: NAME })
      .returning({ id: s.customers.id });
    const order = await insertOrderRow(db, {
      customerId: customer!.id,
      serviceId: auto.serviceId,
      imei: IMEIS[1],
      source: 'store',
    });
    const staff = await adminWith(t, ['orders:read']);
    const res = await t.app.inject({ method: 'GET', url: '/admin/orders/export', headers: staff.session.headers });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    const lines = res.body.split('\r\n');
    expect(lines[1]).toBe(
      `${order.id},${order.createdAt.toISOString()},b2c,${NAME},${MIXED_SERVICE},${IMEIS[1]},pending,,10.0000,0.0000`,
    );
    expect(holdsUtf8(res.rawPayload, `,${NAME},${MIXED_SERVICE},`)).toBe(true);
    expect(res.body).not.toContain('�');
    expect(res.body).not.toContain('?');
  });

  it('the merchant order export: the service name and a typed input in Arabic come back unchanged and the export stays safe from formulas', async () => {
    const { merchant, auto, server } = world;
    const portal = await portalFor(t, merchant.id);
    expect((await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] })).statusCode).toBe(201);
    const typed = await portal.post('/client/orders', { serviceId: server.serviceId, inputs: { username: NAME } });
    expect(typed.statusCode).toBe(201);
    const res = await portal.get('/client/orders/export?_sort=id&_order=asc');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    const [header, first, second] = res.body.split('\r\n');
    expect(header).toBe('id,created,service,input,quantity,status,price,currency');
    expect(first!.split(',')[2]).toBe(MIXED_SERVICE);
    expect(second!.split(',')[3]).toBe(NAME);
    expect(holdsUtf8(res.rawPayload, `,${MIXED_SERVICE},`)).toBe(true);
    expect(holdsUtf8(res.rawPayload, `,${NAME},`)).toBe(true);
  });

  it('the wallet statement export: an Arabic note with Arabic-Indic digits and the Arabic comma is one cell, unchanged', async () => {
    const { db } = await testDb();
    const mine = await insertWalletMerchant(db, { name: NAME });
    await db.transaction((tx) =>
      postTransaction(
        tx,
        {
          ...deposit({ clientId: mine.id, amount: Money.of('100') }),
          refId: 1,
          idempotencyKey: 'arabic-note',
          currency: 'USD',
          memo: NOTE,
          createdBy: { type: 'system', id: null },
        },
        clock.now(),
      ),
    );
    const portal = await portalFor(t, mine.id);
    const res = await portal.get('/client/wallet/statement?format=csv');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    const lines = res.body.split('\r\n');
    expect(lines[0]).toBe('createdAt,transactionId,kind,memo,amount,balanceAfter');
    expect(lines[1]!.split(',').slice(2)).toEqual(['deposit', NOTE, '100.0000', '100.0000']);
    expect(holdsUtf8(res.rawPayload, `,${NOTE},`)).toBe(true);
  });
});

describe('plain-text mails and Telegram carry typed values unchanged (critic G6)', () => {
  /** Writes a `support.ticket_mail` event the way the use cases do, and runs its job. */
  async function runTicketMail(ticketId: number, payload: Record<string, string | number>) {
    const { db } = await testDb();
    const row = await db.transaction((tx) =>
      t.app
        .get(OutboxService)
        .add(tx, { type: TICKET_MAIL_EVENT, aggregateType: 'support_tickets', aggregateId: ticketId, payload }),
    );
    return t.app.get(TicketMailProcessor).process({
      data: {
        eventId: row.id,
        type: TICKET_MAIL_EVENT,
        aggregateType: 'support_tickets',
        aggregateId: ticketId,
        payload,
        requestId: 'test',
      },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as never);
  }

  /** A staff member, for the author of a reply. */
  async function staffMember(db: Awaited<ReturnType<typeof testDb>>['db']) {
    const [role] = await db
      .insert(s.roles)
      .values({ name: 'Support', permissions: ['support:*'] })
      .returning({ id: s.roles.id });
    const [staff] = await db
      .insert(s.staffUsers)
      .values({ email: 'lina@example.com', name: 'Lina S.', roleId: role!.id, status: 'active' })
      .returning();
    return staff!;
  }

  it('an event mail whose {customerName} and {message} are Arabic is plain text: no HTML part, the exact words', async () => {
    const { db } = await testDb();
    await seedSupportTemplates(db);
    const customer = await insertCustomer(db, { name: NAME, email: 'm@mail.example' });
    const ticket = await insertSupportTicket(db, { requesterId: customer.id, subject: 'سؤال عن الطلب' });
    const staff = await staffMember(db);
    const reply = await insertSupportMessage(db, ticket.id, { authorType: 'staff', authorId: staff.id, body: NOTE });
    expect(await runTicketMail(ticket.id, { kind: 'reply', messageId: reply.id, channel: 'email' })).toEqual({
      sent: true,
    });
    const [mail] = mailbox(t).sent;
    expect(mail).toBeDefined();
    expect(mail).not.toHaveProperty('html');
    expect(mail!.text.startsWith(`Hi ${NAME},\n\n${NOTE}\n\nTicket ${ticket.number}: سؤال عن الطلب`)).toBe(true);
    expect(mail!.text).not.toContain('<');
    expect(mail!.to).toBe('m@mail.example');
  });

  it("a Telegram message carries a ticket's Arabic reply as typed", async () => {
    const { db } = await testDb();
    await seedSupportTemplates(db);
    const merchant = await insertClient(db, { name: NAME, telegramChatId: '555001' });
    const ticket = await insertSupportTicket(db, {
      requesterType: 'client',
      requesterId: merchant.id,
      token: null,
      subject: 'مشكلة في الطلب',
    });
    const staff = await staffMember(db);
    const reply = await insertSupportMessage(db, ticket.id, { authorType: 'staff', authorId: staff.id, body: NOTE });
    expect(await runTicketMail(ticket.id, { kind: 'reply', messageId: reply.id, channel: 'telegram' })).toEqual({
      sent: true,
    });
    const [message] = telegramOutbox(t).sent;
    expect(message).toMatchObject({ chatId: '555001' });
    expect(message!.text).toContain(`${ticket.number} (مشكلة في الطلب):\n${NOTE}`);
  });
});

describe("a supplier's service name with Arabic script is shown as it is (critic G4)", () => {
  let world: OrdersWorld;
  let creds: MachineCredentials;

  it('reads back unchanged from the Dhru service list, GET /v1/services and the console list', async () => {
    const { db } = await testDb();
    world = await ordersWorld(db);
    await db.update(s.services).set({ name: MIXED_SERVICE }).where(eq(s.services.id, world.auto.serviceId));
    await db.update(s.services).set({ name: ARABIC_SERVICE }).where(eq(s.services.id, world.manual.serviceId));
    creds = await credentialsFor(t, db, world.merchant.id);

    const dhru = await dhruClient(t, creds).call('imeiservicelist');
    const services = Object.values(
      dhru.SUCCESS[0].LIST as Record<string, { SERVICES: Record<string, { SERVICENAME: string }> }>,
    )
      .flatMap((group) => Object.entries(group.SERVICES))
      .map(([id, service]) => [Number(id), service.SERVICENAME] as const);
    expect(services).toContainEqual([world.auto.serviceId, MIXED_SERVICE]);
    expect(services).toContainEqual([world.manual.serviceId, ARABIC_SERVICE]);

    const v1 = await v1Client(t, creds.key).get('/v1/services');
    expect(v1.statusCode).toBe(200);
    const names = new Map<number, string>(body(v1).data.map((row: { id: number; name: string }) => [row.id, row.name]));
    expect(names.get(world.auto.serviceId)).toBe(MIXED_SERVICE);
    expect(names.get(world.manual.serviceId)).toBe(ARABIC_SERVICE);

    const staff: AdminApi = await adminWith(t, ['catalog:read']);
    const list = await staff.get('/admin/services');
    expect(list.status).toBe(200);
    const adminNames = new Map<number, string>(
      list.body.map((row: { id: number; name: string }) => [row.id, row.name]),
    );
    expect(adminNames.get(world.auto.serviceId)).toBe(MIXED_SERVICE);
    expect(adminNames.get(world.manual.serviceId)).toBe(ARABIC_SERVICE);
  });

  it('copied into a listing title with a staff-given slug, it is the title of the public service page', async () => {
    const { db } = await testDb();
    const listing = await listingWorld(db);
    await db.update(s.services).set({ name: ARABIC_SERVICE }).where(eq(s.services.id, listing.check));
    await insertRetailPrice(db, listing.check, listing.groups.retail, '3.9900');
    const staff = await adminWith(t, ['storefront:*']);

    // No Latin letter or digit: the title makes no web address, so staff give one (the caller supplies a slug).
    const noSlug = await staff.post('/admin/service-listings', {
      serviceId: listing.check,
      publicTitle: ARABIC_SERVICE,
    });
    expect(noSlug.status).toBe(422);
    expect(noSlug.body.errors[0].field).toBe('slug');

    const made = await staff.post('/admin/service-listings', {
      serviceId: listing.check,
      publicTitle: ARABIC_SERVICE,
      slug: 'school-tab-format',
    });
    expect(made.status).toBe(201);
    expect(made.body.publicTitle).toBe(ARABIC_SERVICE);
    expect((await staff.patch(`/admin/service-listings/${made.body.id}`, { isListed: true })).status).toBe(200);

    const page = await t.app.inject({ method: 'GET', url: '/store/v1/services/school-tab-format' });
    expect(page.statusCode).toBe(200);
    expect(page.json().title).toBe(ARABIC_SERVICE);
    expect(page.json().slug).toBe('school-tab-format');
    const list = await t.app.inject({ method: 'GET', url: '/store/v1/services' });
    expect(list.json().map((row: { title: string }) => row.title)).toContain(ARABIC_SERVICE);
  });
});

describe('a ticket message in Arabic round-trips through the store and staff routes', () => {
  const SUBJECT = 'أين رمز الفتح؟';
  const QUESTION = 'دفعت أمس ولم يصلني الرمز حتى الآن، شكراً.';
  const ANSWER = 'مرحباً محمد، الطلب عند المزود وسيكتمل خلال ساعة.';

  const send = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    t.app.inject({
      method,
      url,
      headers,
      remoteAddress: freshClientIp(),
      ...(payload === undefined ? {} : { payload: payload as never }),
    });

  it('the visitor writes Arabic, staff read and answer it, the visitor reads the answer: every byte is kept', async () => {
    const { db } = await testDb();
    await seedSupportTemplates(db);
    const opened = await send(
      'POST',
      '/store/v1/tickets',
      { email: 'm@mail.example', name: NAME, subject: SUBJECT, message: QUESTION },
      TURNSTILE_HEADERS,
    );
    expect(opened.statusCode).toBe(201);
    const [row] = await db.select().from(s.supportTickets);
    expect(row).toMatchObject({ subject: SUBJECT });
    const [customer] = await db.select().from(s.customers);
    expect(customer!.name).toBe(NAME);

    const followUp = await send('POST', `/store/v1/tickets/${row!.token}/messages`, {
      body: ANSWER.replace('مرحباً', 'هل'),
    });
    expect(followUp.statusCode).toBe(201);
    const seen = await send('GET', `/store/v1/tickets/${row!.token}`);
    expect(seen.json().subject).toBe(SUBJECT);
    expect(seen.json().messages.map((message: { body: string }) => message.body)).toEqual([
      QUESTION,
      ANSWER.replace('مرحباً', 'هل'),
    ]);

    const staff = await supportStaff(t);
    const detail = await staff.get(`/admin/support-tickets/${row!.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.subject).toBe(SUBJECT);
    expect(detail.body.messages.map((message: { body: string }) => message.body)).toContain(QUESTION);
    const reply = await staff.post(`/admin/support-tickets/${row!.id}/reply`, { body: ANSWER, channel: 'email' });
    expect(reply.status).toBe(201);
    expect(reply.body.body).toBe(ANSWER);

    const answered = await send('GET', `/store/v1/tickets/${row!.token}`);
    expect(answered.json().messages.at(-1).body).toBe(ANSWER);
    // The text is stored as typed: no trimming of inner marks, no normalisation of the Arabic letters or digits.
    const [stored] = await db.select().from(s.ticketMessages).where(eq(s.ticketMessages.id, reply.body.id));
    expect(stored!.body).toBe(ANSWER);
  });
});
