// Integration tests of the upload janitor (decision 053): the daily job deletes the stored files that nothing references and that are more than
// 7 days old, with their objects, keeps every file something uses and every younger one, goes on after a row that was taken meanwhile, and
// records each run in `job_runs`. Real Postgres, Redis and object storage; a test clock moves the days.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { JobSchedulerRegistry } from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import { StorageService } from '@src/infra/storage';
import {
  PlatformRetentionModule,
  StoredFiles,
  UPLOAD_JANITOR_JOB,
  UploadJanitorProcessor,
} from '@src/modules/platform';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertGateway, insertInvoiceRow, insertPendingPayment } from '../../support/billing';
import { jobLike } from '../../support/campaigns';
import { insertCategory, insertService } from '../../support/catalog';
import { DAY, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertWalletMerchant } from '../../support/money';
import { insertOrderRow } from '../../support/orders';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { insertCustomer, insertSupportMessage, insertSupportTicket } from '../../support/support';
import { insertCurrency } from '../../support/storefront';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-01T04:30:00.000Z');
let t: TestApp;
let db: Database;

beforeAll(async () => {
  db = (await testDb()).db;
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix }, imports: [PlatformRetentionModule] });
});
beforeEach(async () => {
  clock.set('2026-11-01T04:30:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await closeTestDb();
});

const run = (runId?: number) =>
  t.app.get(UploadJanitorProcessor).process(jobLike(runId === undefined ? {} : { runId }));
const fileIds = async () =>
  (await db.select({ id: s.files.id }).from(s.files)).map((row) => row.id).sort((a, b) => a - b);

/** Stores an object and its row, stamped with the test clock's time (the janitor judges age on the same clock). */
async function storedFile(overrides: Partial<typeof s.files.$inferInsert> = {}) {
  const key = `files/2026/11/${crypto.randomUUID()}`;
  const object = await t.app.get(StorageService).put(key, new TextEncoder().encode('%PDF-1.4 stored'), {
    contentType: 'application/pdf',
  });
  const [row] = await db
    .insert(s.files)
    .values({
      bucket: object.bucket,
      key: object.key,
      filename: 'stored.pdf',
      mime: 'application/pdf',
      size: object.size,
      sha256: object.sha256,
      ownerType: 'client',
      ownerId: 1,
      createdAt: clock.now(),
      updatedAt: clock.now(),
      ...overrides,
    })
    .returning();
  return row!;
}
const objectExists = async (key: string) => (await t.app.get(StorageService).get(key)) !== null;

describe('the upload janitor', () => {
  it('deletes a file nothing has used for more than 7 days, with its object', async () => {
    const old = await storedFile();
    clock.advance(7 * DAY + 1000);
    expect(await run()).toEqual({ deleted: 1, kept: 0 });
    expect(await fileIds()).toEqual([]);
    expect(await objectExists(old.key)).toBe(false);
  });

  it('keeps a file of the last 7 days', async () => {
    const fresh = await storedFile();
    clock.advance(7 * DAY - 1000);
    expect(await run()).toEqual({ deleted: 0, kept: 0 });
    expect(await fileIds()).toEqual([fresh.id]);
    expect(await objectExists(fresh.key)).toBe(true);
    clock.advance(2000);
    expect(await run()).toEqual({ deleted: 1, kept: 0 });
  });

  it('keeps a file an order, a ticket message, a KYC submission, a payment, a payment method logo, an invoice or a dispute uses', async () => {
    await insertCurrency(db, { code: 'USD' });
    const merchant = await insertWalletMerchant(db);
    const customer = await insertCustomer(db);
    const serviceId = await insertService(db, await insertCategory(db));

    const used = {
      order: await storedFile(),
      ticket: await storedFile(),
      kyc: await storedFile(),
      payment: await storedFile(),
      logo: await storedFile(),
      invoice: await storedFile(),
      dispute: await storedFile(),
    };
    const unused = await storedFile();

    await insertOrderRow(db, { serviceId, clientId: merchant.id, inputFileId: used.order.id });
    const ticket = await insertSupportTicket(db, { requesterId: customer.id });
    await insertSupportMessage(db, ticket.id, {
      authorType: 'customer',
      authorId: customer.id,
      fileIds: [used.ticket.id],
    });
    await db.insert(s.kycSubmissions).values({ clientId: merchant.id, fileIds: [used.kyc.id] });
    const gatewayId = await insertGateway(t, db, { logoFileId: used.logo.id });
    const invoice = await insertInvoiceRow(db, merchant.id, { gatewayId, pdfFileId: used.invoice.id });
    const payment = await insertPendingPayment(db, invoice, gatewayId, { receiptFileId: used.payment.id });
    await db.insert(s.disputes).values({
      paymentId: payment.id,
      gatewayDisputeId: 'dp_evidence',
      reasonCode: 'fraudulent',
      amount: '10.0000',
      currency: 'USD',
      evidenceDueAt: clock.now(),
      evidenceFileIds: [used.dispute.id],
    });

    clock.advance(8 * DAY);
    expect(await run()).toEqual({ deleted: 1, kept: 0 });
    expect(await fileIds()).toEqual(
      Object.values(used)
        .map((row) => row.id)
        .sort((a, b) => a - b),
    );
    for (const row of Object.values(used)) expect(await objectExists(row.key), row.filename).toBe(true);
    expect(await objectExists(unused.key)).toBe(false);
  });

  it('goes on after a row something started to use meanwhile, and counts it as kept', async () => {
    const first = await storedFile();
    const second = await storedFile();
    clock.advance(8 * DAY);
    const files = t.app.get(StoredFiles);
    const remove = files.remove.bind(files);
    let calls = 0;
    const spy = spyOn(files, 'remove').mockImplementation(async (tx, ids) => {
      calls += 1;
      // The first candidate is taken by a reference that is committed between the read and the delete: a foreign key refuses the delete.
      if (calls === 1) throw Object.assign(new Error('foreign key violation'), { code: '23503' });
      return remove(tx, ids);
    });
    try {
      expect(await run()).toEqual({ deleted: 1, kept: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(await fileIds()).toEqual([first.id]);
    expect(await objectExists(second.key)).toBe(false);
  });

  it('works through a backlog in batches of 500 and stops at 40 batches a run', async () => {
    await db.insert(s.files).values(
      Array.from({ length: 1200 }, (_, index) => ({
        bucket: 'gsm-files',
        key: `files/2026/11/backlog-${index}-${crypto.randomUUID()}`,
        filename: 'x.pdf',
        mime: 'application/pdf',
        size: 1,
        sha256: 'a'.repeat(64),
        ownerType: 'client',
        ownerId: 1,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      })),
    );
    clock.advance(8 * DAY);
    expect(await run()).toEqual({ deleted: 1200, kept: 0 });
    expect(await fileIds()).toEqual([]);
  });

  it('records the run in job_runs and finds nothing on a second run', async () => {
    await storedFile();
    clock.advance(8 * DAY);
    expect(await run()).toEqual({ deleted: 1, kept: 0 });
    const [manual] = await db
      .insert(s.jobRuns)
      .values({ job: UPLOAD_JANITOR_JOB, trigger: 'manual', status: 'running', startedAt: clock.now() })
      .returning({ id: s.jobRuns.id });
    expect(await run(manual!.id)).toEqual({ deleted: 0, kept: 0 });
    const runs = await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, UPLOAD_JANITOR_JOB)).orderBy(s.jobRuns.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ trigger: 'schedule', status: 'succeeded', processed: 1 });
    expect(runs[0]!.result).toEqual({ deleted: 1, kept: 0 });
    expect(runs[1]).toMatchObject({ id: manual!.id, trigger: 'manual', status: 'succeeded', processed: 0 });
  });

  it('is scheduled daily at 04:30 on the maintenance queue', () => {
    const entry = t.app
      .get(JobSchedulerRegistry)
      .list()
      .find((scheduler) => scheduler.id === 'upload-janitor');
    expect(entry).toMatchObject({ queue: 'maintenance', jobName: UPLOAD_JANITOR_JOB, pattern: '30 4 * * *' });
  });
});
