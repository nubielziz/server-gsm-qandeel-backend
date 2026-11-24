// Integration tests of the attachments of the support chat (feature 28, rules 8 and 10): the upload refusals of the ticket page and the
// console, the ownership, type and size check when a message attaches files (a customer's, a merchant's and a staff member's), the
// download of a requester (public messages of their own ticket only) and of staff (every file of the ticket), the deletion with an
// anonymized customer, and the retention of resolved tickets. Real Postgres, Redis and object storage.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Readable } from 'node:stream';
import { eq, inArray } from 'drizzle-orm';
import { AppError } from '@src/common/errors';
import { schema as s } from '@src/infra/db';
import { StorageService } from '@src/infra/storage';
import { SupportJobsModule } from '@src/modules/support';
import { TicketAttachmentService } from '@src/modules/support/application/ticket-attachment.service';
import { TicketThreadService } from '@src/modules/support/application/ticket-thread.service';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { ensureRetailGroup } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertMerchant } from '../../support/auth';
import { insertGateway, insertInvoiceRow, insertPendingPayment } from '../../support/billing';
import { DAY, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { eventually } from '../../support/infra';
import { multipartRequest } from '../../support/machine-orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { rejectionOf } from '../../support/rejection';
import { insertUsd } from '../../support/portal-orders';
import { CONSOLE_ORIGIN } from '../../support/staff-console';
import { makeCustomer } from '../../support/store';
import {
  clearTicketChatLimits,
  insertSupportMessage,
  insertSupportTicket,
  seedSupportTemplates,
  setSupportSetting,
  supportStaff,
} from '../../support/support';

const NOW = '2026-11-15T10:00:00.000Z';
const clock = new TestClock(NOW);
let t: TestApp;
let staff: AdminApi;

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
const MIB = 1024 * 1024;

beforeAll(async () => {
  // The worker's support jobs too: the retention run is tested here.
  t = await createTestApp({ clock, imports: [SupportJobsModule] });
});
beforeEach(async () => {
  clock.set(NOW);
  await resetDb();
  const { db } = await testDb();
  // the reset removed the one retail rank that the migrations insert; the console reads it to tell the requester's rank
  await ensureRetailGroup(db);
  await seedSupportTemplates(db);
  await clearIdentityCaches(t);
  await clearTicketChatLimits(t);
  await setSupportSetting(t, 'replyEmailDelayMinutes', 0);
  staff = await supportStaff(t, ['support:*'], 'Lina S.');
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** A customer and a ticket of theirs with a first message. */
async function customerTicket() {
  const { db } = await testDb();
  const customer = await makeCustomer(t, { name: 'Victor Hale' });
  const ticket = await insertSupportTicket(db, { requesterId: customer.id, status: 'open' });
  // Written a minute before the clock's now, like a message of the past (the default would be the wall clock).
  await insertSupportMessage(db, ticket.id, {
    authorType: 'account',
    authorId: customer.id,
    body: 'Hello.',
    createdAt: new Date(clock.nowMs() - 60_000),
  });
  return { db, customer, ticket: { ...ticket, token: ticket.token! } };
}

const form = (name: string, type: string, bytes: Uint8Array) => {
  const body = new FormData();
  body.set('file', new File([bytes], name, { type }));
  return body;
};

/** Uploads through the ticket page. */
const pageUpload = (token: string, name: string, type: string, bytes: Uint8Array) =>
  multipartRequest(t, `/store/v1/tickets/${token}/files`, form(name, type, bytes), {}, freshClientIp());

/** Uploads through the console as a staff member. */
const consoleUpload = (api: AdminApi, ticketId: number, name: string, type: string, bytes: Uint8Array) =>
  multipartRequest(
    t,
    `/admin/support-tickets/${ticketId}/files`,
    form(name, type, bytes),
    { ...api.session.mutationHeaders, origin: CONSOLE_ORIGIN },
    api.ip,
  );

const onTicket = (method: 'GET' | 'POST', token: string, path: string, payload?: unknown) =>
  t.app.inject({
    method,
    url: `/store/v1/tickets/${token}${path}`,
    remoteAddress: freshClientIp(),
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

/** Inserts a file row straight into the table (an upload the platform made, of any type and size). */
async function fileRow(
  ownerType: 'account' | 'staff',
  ownerId: number,
  values: Partial<typeof s.files.$inferInsert> = {},
) {
  const { db } = await testDb();
  const [row] = await db
    .insert(s.files)
    .values({
      bucket: 'gsm-files',
      key: `files/${crypto.randomUUID()}`,
      filename: 'upload.pdf',
      mime: 'application/pdf',
      size: 1000,
      sha256: 'a'.repeat(64),
      ownerType,
      ownerId,
      ...values,
    })
    .returning();
  return row!;
}

const errorOf = (res: { json: () => unknown }) =>
  (res.json() as { errors: { field: string; code: string }[] }).errors[0];

describe('the uploads', () => {
  it('store a PDF from the ticket page as the customer’s file and a PNG from the console as the staff member’s', async () => {
    const { db, ticket, customer } = await customerTicket();
    const page = await pageUpload(ticket.token, '../statement.pdf', 'application/pdf', PDF);
    expect(page.statusCode).toBe(201);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.json()).toMatchObject({ filename: 'statement.pdf', mime: 'application/pdf', size: PDF.length });
    const console = await consoleUpload(staff, ticket.id, 'screen.png', 'image/png', PNG);
    expect(console.statusCode).toBe(201);
    const rows = await db.select().from(s.files).orderBy(s.files.id);
    expect(rows.map((row) => [row.ownerType, row.ownerId])).toEqual([
      ['account', customer.id],
      ['staff', staff.staffId],
    ]);
    // A requester's upload is stored under its ticket's own area, a staff upload under the shared one.
    expect(rows[0]!.key.startsWith(`tickets-${ticket.id}/account-${customer.id}/`)).toBe(true);
    expect(rows[1]!.key.startsWith(`tickets/staff-${staff.staffId}/`)).toBe(true);
    const audits = await db.select().from(s.auditLogs);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'attached file to ticket',
      entityType: 'ticket',
      entityId: ticket.id,
      after: { fileId: console.json().id, filename: 'screen.png', size: PNG.length },
    });
  });

  it('holds a requester’s link upload to the quota of its rank kind: a retail rank stops at 30 files in 24 hours, a merchant rank does not ', async () => {
    const { db, customer, ticket } = await customerTicket();
    const merchantId = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const merchantTicket = await insertSupportTicket(db, { requesterId: merchantId, status: 'open' });
    // Each account already holds 30 uploads of the last day, as the shop's and the portal's upload routes store them.
    for (const owner of [customer.id, merchantId]) {
      for (let n = 0; n < 30; n += 1) await fileRow('account', owner);
    }
    const retail = await pageUpload(ticket.token, 'one-more.pdf', 'application/pdf', PDF);
    expect(retail.statusCode).toBe(422);
    expect(errorOf(retail)).toMatchObject({ field: 'file', code: 'quota' });
    const merchant = await pageUpload(merchantTicket.token!, 'one-more.pdf', 'application/pdf', PDF);
    expect(merchant.statusCode).toBe(201);
    expect(await db.select().from(s.files).where(eq(s.files.ownerId, merchantId))).toHaveLength(31);
  });

  it('refuses a ticket-link upload over 5 MiB that declares no length, before it is parsed (decision 053)', async () => {
    const { ticket } = await customerTicket();
    // Not a valid multipart body on purpose: a refusal before the parser is a 413, a parse of these bytes would be a 400.
    const chunks = Array.from({ length: 6 }, () => Buffer.alloc(MIB, 97));
    const res = await t.app.inject({
      method: 'POST',
      url: `/store/v1/tickets/${ticket.token}/files`,
      remoteAddress: freshClientIp(),
      headers: { 'content-type': 'multipart/form-data; boundary=gsm' },
      payload: Readable.from(chunks),
    });
    expect(res.statusCode).toBe(413);
    const staffRes = await t.app.inject({
      method: 'POST',
      url: `/admin/support-tickets/${ticket.id}/files`,
      remoteAddress: staff.ip,
      headers: {
        ...staff.session.mutationHeaders,
        origin: CONSOLE_ORIGIN,
        'content-type': 'multipart/form-data; boundary=gsm',
      },
      payload: Readable.from(chunks),
    });
    expect(staffRes.statusCode).toBe(413);
    expect(await (await testDb()).db.select().from(s.files)).toEqual([]);
  });

  it('refuses another type by its name, a renamed program by its content, an empty file and one over 5 MiB', async () => {
    const { ticket } = await customerTicket();
    const text = await pageUpload(ticket.token, 'notes.txt', 'text/plain', new TextEncoder().encode('hello'));
    expect(text.statusCode).toBe(422);
    expect(errorOf(text)).toMatchObject({ field: 'file', code: 'type' });
    const renamed = await pageUpload(ticket.token, 'invoice.pdf', 'application/pdf', EXE);
    expect(renamed.statusCode).toBe(422);
    expect(errorOf(renamed)).toMatchObject({ field: 'file', code: 'type' });
    const empty = await pageUpload(ticket.token, 'empty.png', 'image/png', new Uint8Array());
    expect(empty.statusCode).toBe(422);
    expect(errorOf(empty)).toMatchObject({ field: 'file', code: 'empty' });
    const big = new Uint8Array(5 * MIB + 1);
    big.set(PDF);
    expect((await pageUpload(ticket.token, 'big.pdf', 'application/pdf', big)).statusCode).toBe(413);
    expect((await consoleUpload(staff, ticket.id, 'big.pdf', 'application/pdf', big)).statusCode).toBe(413);
    // A declared body far over the bound is refused before it is read.
    expect((await pageUpload(ticket.token, 'huge.pdf', 'application/pdf', new Uint8Array(6 * MIB))).statusCode).toBe(
      413,
    );
    const { db } = await testDb();
    expect(await db.select().from(s.files)).toEqual([]);
    expect((await consoleUpload(staff, 999_999, 'a.pdf', 'application/pdf', PDF)).statusCode).toBe(404);
    const reader = await adminWith(t, ['support:read']);
    expect((await consoleUpload(reader, ticket.id, 'a.pdf', 'application/pdf', PDF)).statusCode).toBe(403);
  });

  it('refuse the customer’s upload for a resolved ticket with 409 TICKET_RESOLVED and store nothing, until staff reopen it (B220)', async () => {
    const { db, ticket } = await customerTicket();
    expect((await staff.patch(`/admin/support-tickets/${ticket.id}`, { status: 'resolved' })).status).toBe(200);
    const refused = await pageUpload(ticket.token, 'statement.pdf', 'application/pdf', PDF);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: 'TICKET_RESOLVED',
      detail: 'This ticket is closed. Open a new ticket if you still need help.',
    });
    // No orphan: no file row, and the ticket is as the resolve left it.
    expect(await db.select().from(s.files)).toEqual([]);
    const [resolved] = await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, ticket.id));
    expect(resolved!.status).toBe('resolved');

    expect((await staff.patch(`/admin/support-tickets/${ticket.id}`, { status: 'open' })).status).toBe(200);
    const again = await pageUpload(ticket.token, 'statement.pdf', 'application/pdf', PDF);
    expect(again.statusCode).toBe(201);
    expect(await db.select().from(s.files)).toHaveLength(1);
  });
});

describe('attaching files to a message', () => {
  it('takes the sender’s own files, files only, and refuses a sixth file', async () => {
    const { ticket } = await customerTicket();
    const ids: number[] = [];
    for (let n = 0; n < 6; n++)
      ids.push((await pageUpload(ticket.token, `p${n}.pdf`, 'application/pdf', PDF)).json().id);
    const six = await onTicket('POST', ticket.token, '/messages', { body: 'Six.', fileIds: ids });
    expect(six.statusCode).toBe(422);
    expect(errorOf(six)).toMatchObject({ field: 'fileIds', message: 'Attach at most 5 files.' });
    const filesOnly = await onTicket('POST', ticket.token, '/messages', { body: '', fileIds: ids.slice(0, 2) });
    expect(filesOnly.statusCode).toBe(201);
    expect(filesOnly.json()).toMatchObject({
      body: '',
      attachments: [
        { id: ids[0], filename: 'p0.pdf', mime: 'application/pdf', size: PDF.length },
        { id: ids[1], filename: 'p1.pdf' },
      ],
    });
    const nothing = await onTicket('POST', ticket.token, '/messages', { body: '  ' });
    expect(nothing.statusCode).toBe(422);
    expect(errorOf(nothing)).toMatchObject({ field: 'body', code: 'too_small' });
    const reply = await staff.post(`/admin/support-tickets/${ticket.id}/reply`, {
      body: '',
      fileIds: [(await consoleUpload(staff, ticket.id, 'a.png', 'image/png', PNG)).json().id],
    });
    expect(reply.status).toBe(201);
    expect(reply.body.attachments).toHaveLength(1);
    const shown = (await onTicket('GET', ticket.token, '')).json();
    expect(shown.messages.map((message: { attachments: unknown[] }) => message.attachments.length)).toEqual([0, 2, 1]);
  });

  it('refuses an unknown id and a file of another customer, of another merchant or of another staff member (not_yours)', async () => {
    const { ticket } = await customerTicket();
    const { ticket: other } = await customerTicket();
    const foreign = (await pageUpload(other.token, 'theirs.pdf', 'application/pdf', PDF)).json().id;
    const unknown = await onTicket('POST', ticket.token, '/messages', { body: 'x', fileIds: [999_999] });
    expect(errorOf(unknown)).toMatchObject({ field: 'fileIds', code: 'unknown_file' });
    const stolen = await onTicket('POST', ticket.token, '/messages', { body: 'x', fileIds: [foreign] });
    expect(stolen.statusCode).toBe(422);
    expect(errorOf(stolen)).toMatchObject({ field: 'fileIds', code: 'not_yours' });

    const colleague = await supportStaff(t, ['support:*'], 'Rami K.');
    const theirs = (await consoleUpload(colleague, ticket.id, 'r.pdf', 'application/pdf', PDF)).json().id;
    const reply = await staff.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'x', fileIds: [theirs] });
    expect(reply.status).toBe(422);
    expect(reply.body.errors[0]).toMatchObject({ field: 'fileIds', code: 'not_yours' });
    const note = await staff.post(`/admin/support-tickets/${ticket.id}/note`, { body: 'x', fileIds: [theirs] });
    expect(note.body.errors[0]).toMatchObject({ field: 'fileIds', code: 'not_yours' });

    // A merchant writes through the thread service (its routes are slice B2's): another merchant's file, and its own 20 MiB upload.
    const { db } = await testDb();
    const merchant = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const rival = await insertMerchant(db, { name: 'Other Shop' });
    const merchantTicket = await insertSupportTicket(db, {
      requesterType: 'account',
      requesterId: merchant,
      token: null,
    });
    const writer = { via: 'account', id: merchant } as const;
    const thread = t.app.get(TicketThreadService);
    for (const [file, code] of [
      [await fileRow('account', rival), 'not_yours'],
      [await fileRow('account', merchant, { size: 20 * MIB }), 'too_large'],
      [await fileRow('account', merchant, { mime: 'application/zip', filename: 'firmware.zip' }), 'type'],
    ] as const) {
      const error = await rejectionOf(thread.write(merchantTicket.id, writer, { body: 'x', fileIds: [file.id] }));
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).errors[0]).toMatchObject({ field: 'fileIds', code });
    }
    const own = await fileRow('account', merchant);
    expect((await thread.write(merchantTicket.id, writer, { body: '', fileIds: [own.id] })).attachments).toHaveLength(
      1,
    );
    // A ticket of another merchant is not the writer's: 404.
    const error = await rejectionOf(thread.write(merchantTicket.id, { ...writer, id: rival }, { body: 'x' }));
    expect((error as AppError).code).toBe('NOT_FOUND');
  });

  it('takes from a ticket link only the uploads of that ticket: the customer’s receipt and other uploads are not_yours, and 404', async () => {
    const { db, customer, ticket } = await customerTicket();
    const second = await insertSupportTicket(db, { requesterId: customer.id, status: 'open' });
    // The customer's own files that did not come through this ticket: a tax receipt (billing stores it under `receipts`), a bank
    // transfer receipt of `POST /store/v1/files` (under `files`) and an upload through their other ticket.
    const receipt = await fileRow('account', customer.id, {
      key: `receipts/account-${customer.id}/${crypto.randomUUID()}`,
      filename: 'receipt-ORD-1001.pdf',
    });
    const transfer = await fileRow('account', customer.id);
    const elsewhere = (await pageUpload(second.token!, 'other.pdf', 'application/pdf', PDF)).json().id;
    for (const id of [receipt.id, transfer.id, elsewhere]) {
      const res = await onTicket('POST', ticket.token, '/messages', { body: 'x', fileIds: [id] });
      expect(res.statusCode, String(id)).toBe(422);
      expect(errorOf(res)).toMatchObject({ field: 'fileIds', code: 'not_yours' });
      expect((await onTicket('GET', ticket.token, `/files/${id}`)).statusCode, String(id)).toBe(404);
    }
    const stored = await db
      .select({ fileIds: s.ticketMessages.fileIds })
      .from(s.ticketMessages)
      .where(eq(s.ticketMessages.ticketId, ticket.id));
    expect(stored.flatMap((row) => row.fileIds)).toEqual([]);
    // The ticket's own upload is taken, and the other ticket's link takes its own.
    const own = (await pageUpload(ticket.token, 'mine.pdf', 'application/pdf', PDF)).json().id;
    expect((await onTicket('POST', ticket.token, '/messages', { body: '', fileIds: [own] })).statusCode).toBe(201);
    expect((await onTicket('POST', second.token!, '/messages', { body: '', fileIds: [elsewhere] })).statusCode).toBe(
      201,
    );
    // A signed-in requester is not limited to one ticket's uploads (the owner alone decides, slice B2).
    const signedIn = await t.app
      .get(TicketThreadService)
      .write(ticket.id, { via: 'account', id: customer.id }, { body: '', fileIds: [transfer.id] });
    expect(signedIn.attachments).toHaveLength(1);
  });
});

describe('the downloads', () => {
  it('give the requester a public message’s file and 404 for a note’s, another ticket’s and an unattached file; staff get all', async () => {
    const { ticket } = await customerTicket();
    const { ticket: other } = await customerTicket();
    const publicFile = (await pageUpload(ticket.token, 'Rechnung März.pdf', 'application/pdf', PDF)).json().id;
    await onTicket('POST', ticket.token, '/messages', { body: 'Here.', fileIds: [publicFile] });
    const noteFile = (await consoleUpload(staff, ticket.id, 'internal.png', 'image/png', PNG)).json().id;
    await staff.post(`/admin/support-tickets/${ticket.id}/note`, { body: 'Internal.', fileIds: [noteFile] });
    const otherFile = (await pageUpload(other.token, 'other.pdf', 'application/pdf', PDF)).json().id;
    await onTicket('POST', other.token, '/messages', { body: 'Other.', fileIds: [otherFile] });
    const loose = (await pageUpload(ticket.token, 'loose.pdf', 'application/pdf', PDF)).json().id;

    const res = await onTicket('GET', ticket.token, `/files/${publicFile}`);
    expect(res.statusCode).toBe(302);
    expect(res.headers['cache-control']).toBe('no-store');
    const link = new URL(String(res.headers.location));
    expect(link.searchParams.get('X-Amz-Expires')).toBe('300');
    const disposition = decodeURIComponent(link.searchParams.get('response-content-disposition') ?? '');
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('Rechnung');
    for (const refused of [noteFile, otherFile, loose, 999_999]) {
      expect((await onTicket('GET', ticket.token, `/files/${refused}`)).statusCode, String(refused)).toBe(404);
    }
    for (const allowed of [publicFile, noteFile]) {
      expect((await staff.get(`/admin/support-tickets/${ticket.id}/files/${allowed}`)).status).toBe(302);
    }
    expect((await staff.get(`/admin/support-tickets/${ticket.id}/files/${otherFile}`)).status).toBe(404);
    expect((await staff.get(`/admin/support-tickets/${ticket.id}/files/${loose}`)).status).toBe(404);
    const outsider = await adminWith(t, ['orders:read']);
    expect((await outsider.get(`/admin/support-tickets/${ticket.id}/files/${publicFile}`)).status).toBe(403);
    // The thread shows the attachments to staff too.
    const thread = (await staff.get(`/admin/support-tickets/${ticket.id}`)).body;
    expect(
      thread.messages.flatMap((message: { attachments: { id: number }[] }) => message.attachments.map((a) => a.id)),
    ).toEqual([publicFile, noteFile]);
  });
});

describe('opening a file that is also an identity document or a payment proof (decision 047)', () => {
  const opened = async (action: string) => {
    const { db } = await testDb();
    return db.select().from(s.auditLogs).where(eq(s.auditLogs.action, action)).orderBy(s.auditLogs.id);
  };

  it('leaves the audit row of the file route for staff, and none for an ordinary attachment', async () => {
    const { db, customer, ticket } = await customerTicket();
    const merchantId = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const passport = await fileRow('account', merchantId, { filename: 'passport.pdf' });
    const [submission] = await db
      .insert(s.kycSubmissions)
      .values({ clientId: merchantId, fileIds: [passport.id] })
      .returning();
    await insertUsd(db);
    const gatewayId = await insertGateway(t, db);
    const invoice = await insertInvoiceRow(db, merchantId);
    const receipt = await fileRow('account', merchantId, { filename: 'receipt.pdf' });
    const payment = await insertPendingPayment(db, invoice, gatewayId, { receiptFileId: receipt.id });
    const ordinary = await fileRow('account', customer.id, { filename: 'screenshot.png', mime: 'image/png' });
    // The requester attached all three to messages of the ticket (the files are rows of the table, whatever they are used for elsewhere).
    for (const file of [passport, receipt, ordinary]) {
      await insertSupportMessage(db, ticket.id, { authorType: 'account', authorId: customer.id, fileIds: [file.id] });
    }
    const open = (fileId: number) => staff.get(`/admin/support-tickets/${ticket.id}/files/${fileId}`);

    expect((await open(ordinary.id)).status).toBe(302);
    expect(await opened('opened an identity document of')).toHaveLength(0);
    expect(await opened('opened the payment proof of')).toHaveLength(0);

    expect((await open(passport.id)).status).toBe(302);
    const [identity] = await opened('opened an identity document of');
    expect(identity).toMatchObject({
      entityType: 'account',
      entityId: merchantId,
      entityLabel: 'Zain Mobile Hub',
      actorId: staff.staffId,
      after: { fileId: passport.id, kycSubmissionId: submission!.id },
    });
    expect((await open(receipt.id)).status).toBe(302);
    const [proof] = await opened('opened the payment proof of');
    expect(proof).toMatchObject({
      entityType: 'payment',
      entityId: payment.id,
      entityLabel: `PAY-${payment.id}`,
      actorId: staff.staffId,
      after: { fileId: receipt.id },
    });
    // Every opening writes its row, the same rows as the file route's.
    expect((await open(passport.id)).status).toBe(302);
    expect(await opened('opened an identity document of')).toHaveLength(2);
    // An unknown file of the ticket answers 404 and writes nothing; a requester opening its own file writes nothing.
    expect((await open(999_999)).status).toBe(404);
    expect(await opened('opened an identity document of')).toHaveLength(2);
    expect((await onTicket('GET', ticket.token, `/files/${passport.id}`)).statusCode).toBe(302);
    expect(await opened('opened an identity document of')).toHaveLength(2);
    expect(await opened('opened the payment proof of')).toHaveLength(1);
  });
});

describe('the deletion', () => {
  it('removes every attachment of an anonymized customer’s tickets, rows and objects, and keeps the texts', async () => {
    const { db, ticket, customer } = await customerTicket();
    const mine = (await pageUpload(ticket.token, 'mine.pdf', 'application/pdf', PDF)).json().id as number;
    await onTicket('POST', ticket.token, '/messages', { body: 'With a file.', fileIds: [mine] });
    const theirs = (await consoleUpload(staff, ticket.id, 'reply.png', 'image/png', PNG)).json().id as number;
    await staff.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Answer.', fileIds: [theirs] });
    const keys = (
      await db
        .select()
        .from(s.files)
        .where(inArray(s.files.id, [mine, theirs]))
    ).map((row) => row.key);
    const storage = t.app.get(StorageService);
    for (const key of keys) expect(await storage.head(key)).not.toBeNull();

    const privacy = await adminWith(t, ['customers:privacy']);
    expect((await privacy.post(`/admin/clients/${customer.id}/anonymize`)).status).toBe(204);
    expect(
      await db
        .select()
        .from(s.files)
        .where(inArray(s.files.id, [mine, theirs])),
    ).toEqual([]);
    for (const key of keys) await eventually(async () => ((await storage.head(key)) === null ? true : undefined));
    const messages = await db
      .select()
      .from(s.ticketMessages)
      .where(eq(s.ticketMessages.ticketId, ticket.id))
      .orderBy(s.ticketMessages.id);
    expect(messages.map((message) => [message.body, message.fileIds])).toEqual([
      ['Hello.', []],
      ['With a file.', []],
      ['Answer.', []],
    ]);
  });
});

describe('the retention', () => {
  it('deletes the files of tickets resolved longer ago than the setting, and nothing with the setting 0', async () => {
    const { db } = await testDb();
    const customer = await makeCustomer(t);
    const ticketWith = async (resolvedDaysAgo: number) => {
      const ticket = await insertSupportTicket(db, {
        requesterId: customer.id,
        status: 'resolved',
        resolvedAt: new Date(clock.nowMs() - resolvedDaysAgo * DAY),
      });
      const file = await fileRow('account', customer.id);
      await insertSupportMessage(db, ticket.id, { authorType: 'account', authorId: customer.id, fileIds: [file.id] });
      return file.id;
    };
    const old = await ticketWith(181);
    const recent = await ticketWith(10);
    // A file another record still uses is kept: the same file on an open ticket.
    const shared = await ticketWith(200);
    const open = await insertSupportTicket(db, { requesterId: customer.id, status: 'open' });
    await insertSupportMessage(db, open.id, { authorType: 'account', authorId: customer.id, fileIds: [shared] });

    await setSupportSetting(t, 'attachmentRetentionDays', 0);
    expect(await t.app.get(TicketAttachmentService).applyRetention()).toEqual({ days: 0, tickets: 0, files: 0 });
    expect(await db.select().from(s.files)).toHaveLength(3);

    await setSupportSetting(t, 'attachmentRetentionDays', 180);
    expect(await t.app.get(TicketAttachmentService).applyRetention()).toEqual({ days: 180, tickets: 2, files: 1 });
    expect((await db.select().from(s.files)).map((row) => row.id).sort()).toEqual([recent, shared].sort());
    expect(await db.select().from(s.files).where(eq(s.files.id, old))).toEqual([]);
    // A second run finds nothing more.
    expect(await t.app.get(TicketAttachmentService).applyRetention()).toEqual({ days: 180, tickets: 0, files: 0 });
  });

  it('keeps a file that a payment method uses as its logo (feature 32), and still deletes the one nothing uses', async () => {
    const { db } = await testDb();
    const customer = await makeCustomer(t);
    const ticket = await insertSupportTicket(db, {
      requesterId: customer.id,
      status: 'resolved',
      resolvedAt: new Date(clock.nowMs() - 200 * DAY),
    });
    const logo = await fileRow('account', customer.id);
    const plain = await fileRow('account', customer.id);
    await insertSupportMessage(db, ticket.id, {
      authorType: 'account',
      authorId: customer.id,
      fileIds: [logo.id, plain.id],
    });
    const gatewayId = await insertGateway(t, db, { isManual: true, logoFileId: logo.id });

    await setSupportSetting(t, 'attachmentRetentionDays', 180);
    expect(await t.app.get(TicketAttachmentService).applyRetention()).toEqual({ days: 180, tickets: 1, files: 1 });
    expect((await db.select().from(s.files)).map((row) => row.id)).toEqual([logo.id]);
    // The logo is still the method's: the foreign key alone (ON DELETE SET NULL) would have emptied it silently.
    const [gateway] = await db.select().from(s.paymentGateways).where(eq(s.paymentGateways.id, gatewayId));
    expect(gateway!.logoFileId).toBe(logo.id);
  });
});
