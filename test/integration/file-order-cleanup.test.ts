// Integration tests of the cleanup of a refused file order (P4a, MISMATCHES B166): a Dhru `placefileorder` stores the upload first; when the
// placement is refused (price changed, not enough credits) the object and its `files` row go again. A file that something points at stays.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { schema as s } from '../../src/infra/db';
import { StorageService } from '../../src/infra/storage';
import { ListedPrices } from '../../src/modules/catalog';
import { FileUploadService, MaintenanceService } from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { type MachineCredentials, clearApiKeyCaches, credentialsFor, dhruClient } from '../support/machine-orders';
import { fundWallet, insertWalletMerchant } from '../support/money';
import { type OrdersWorld, ordersWorld, orderRow, walletOf } from '../support/orders';

const clock = new TestClock();
let t: TestApp;
let world: OrdersWorld;
let creds: MachineCredentials;
let dhru: ReturnType<typeof dhruClient>;
let fileServiceId: number;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  await t.app.get(MaintenanceService).invalidate();
  const { db } = await testDb();
  world = await ordersWorld(db);
  creds = await credentialsFor(t, db, world.merchant.id);
  dhru = dhruClient(t, creds);
  const category = await insertCategory(db, { name: 'Files', type: 'file' });
  fileServiceId = await insertService(db, category, {
    type: 'file',
    name: 'Firmware flash',
    code: 'FILE-3',
    basePrice: '3.0000',
  });
});
afterEach(() => {
  // Restores the spies of the storage service.
  spyOn(t.app.get(StorageService), 'put').mockRestore();
});

/** The message of an ERROR answer. */
const messageOf = (answer: { ERROR?: Array<{ MESSAGE: string }> }) => answer.ERROR?.[0]?.MESSAGE;

/** Records the keys of the objects the storage service is asked to put, while still storing them. */
function watchStorage() {
  const put = spyOn(t.app.get(StorageService), 'put');
  return { keys: () => put.mock.calls.map((call) => call[0]) };
}

/** Sends a file order with `FILEDATA`. */
const placeFile = (client: ReturnType<typeof dhruClient> = dhru, name = 'firmware.bin') =>
  client.call('placefileorder', {
    ID: fileServiceId,
    FILENAME: name,
    FILEDATA: Buffer.from('firmware bytes').toString('base64'),
  });

describe('a refused Dhru file order leaves no file', () => {
  it('after "Price changed": the upload was stored, then its object and row are removed, and nothing is held', async () => {
    const { db } = await testDb();
    await t.app
      .get(ListedPrices)
      .record(db, world.merchant.id, [{ serviceId: fileServiceId, price: Money.of('3.0000') }], clock.now());
    await db.update(s.services).set({ basePrice: '25.0000' }).where(eq(s.services.id, fileServiceId));
    const storage = watchStorage();
    const answer = await placeFile();
    expect(messageOf(answer)).toBe('Price changed. Please refresh the service list and order again.');
    // The upload did reach the store, and it is gone again.
    expect(storage.keys()).toHaveLength(1);
    expect(await t.app.get(StorageService).head(storage.keys()[0]!)).toBeNull();
    expect(await db.select().from(s.files)).toHaveLength(0);
    expect(await db.select().from(s.orders)).toHaveLength(0);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
  });

  it('after "Not enough credits": no object, no files row, no order', async () => {
    const { db } = await testDb();
    const poorMerchant = await insertWalletMerchant(db, { name: 'Poor Co' });
    await fundWallet(db, poorMerchant.id, '1');
    const poor = dhruClient(t, await credentialsFor(t, db, poorMerchant.id));
    const storage = watchStorage();
    expect(messageOf(await placeFile(poor))).toBe('Not enough credits');
    expect(storage.keys()).toHaveLength(1);
    expect(await t.app.get(StorageService).head(storage.keys()[0]!)).toBeNull();
    expect(await db.select().from(s.files)).toHaveLength(0);
    expect(await walletOf(db, poorMerchant.id)).toEqual({ wallet: '1.0000', hold: '0.0000' });
  });

  it('keeps the files of an order that was placed, and the earlier uploads of the merchant after a later refusal', async () => {
    const { db } = await testDb();
    const storage = watchStorage();
    const placed = await placeFile();
    expect(placed.SUCCESS[0].MESSAGE).toBe('Order received');
    const order = await orderRow(db, Number(placed.SUCCESS[0].REFERENCEID));
    expect(order.inputFileId).not.toBeNull();
    // A file the merchant uploaded on its own and has not used yet.
    const spare = await t.app.get(FileUploadService).upload(world.merchant.id, {
      filename: 'spare.bin',
      mime: 'application/octet-stream',
      data: Buffer.from('spare'),
    });
    // A refused order of the same merchant (the wallet cannot pay a second 100 USD service).
    await db.update(s.services).set({ basePrice: '500.0000' }).where(eq(s.services.id, fileServiceId));
    expect(messageOf(await placeFile(dhru, 'second.bin'))).toBe('Not enough credits');
    const rows = await db.select().from(s.files).orderBy(s.files.id);
    expect(rows.map((row) => row.id)).toEqual([order.inputFileId!, spare.id]);
    for (const key of rows.map((row) => row.key)) expect(await t.app.get(StorageService).head(key)).not.toBeNull();
    expect(storage.keys()).toHaveLength(3);
  });
});

describe('FileUploadService.discard', () => {
  const upload = (clientId: number, name = 'a.bin') =>
    t.app
      .get(FileUploadService)
      .upload(clientId, { filename: name, mime: 'application/octet-stream', data: Buffer.from(name) });

  it('removes a file nothing points at: the row and the object', async () => {
    const { db } = await testDb();
    const file = await upload(world.merchant.id);
    const [row] = await db.select().from(s.files).where(eq(s.files.id, file.id));
    expect(await t.app.get(FileUploadService).discard(world.merchant.id, file.id)).toBe(true);
    expect(await db.select().from(s.files)).toHaveLength(0);
    expect(await t.app.get(StorageService).head(row!.key)).toBeNull();
    // Gone already: nothing to do, nothing thrown.
    expect(await t.app.get(FileUploadService).discard(world.merchant.id, file.id)).toBe(false);
  });

  it('keeps a file an order points at (foreign key), and its object', async () => {
    const { db } = await testDb();
    const placed = await placeFile();
    const order = await orderRow(db, Number(placed.SUCCESS[0].REFERENCEID));
    expect(await t.app.get(FileUploadService).discard(world.merchant.id, order.inputFileId!)).toBe(false);
    const [row] = await db.select().from(s.files).where(eq(s.files.id, order.inputFileId!));
    expect(row).toBeDefined();
    expect(await t.app.get(StorageService).head(row!.key)).not.toBeNull();
  });

  it('keeps a file a KYC submission lists in its array column (ticket messages and disputes are checked by the same statement)', async () => {
    const { db } = await testDb();
    const kyc = await upload(world.merchant.id, 'kyc.pdf');
    await db.insert(s.kycSubmissions).values({ clientId: world.merchant.id, fileIds: [kyc.id] });
    expect(await t.app.get(FileUploadService).discard(world.merchant.id, kyc.id)).toBe(false);
    expect(await db.select().from(s.files).where(eq(s.files.id, kyc.id))).toHaveLength(1);
  });

  it('never removes the file of another merchant or of staff', async () => {
    const { db } = await testDb();
    const theirs = await upload(world.other.id, 'theirs.bin');
    expect(await t.app.get(FileUploadService).discard(world.merchant.id, theirs.id)).toBe(false);
    const [staffFile] = await db
      .insert(s.files)
      .values({
        bucket: 'gsm-files-test',
        key: 'files/test/staff',
        filename: 'staff.bin',
        mime: 'application/octet-stream',
        size: 1,
        sha256: 'aa',
        ownerType: 'staff',
        ownerId: 1,
      })
      .returning();
    expect(await t.app.get(FileUploadService).discard(world.merchant.id, staffFile!.id)).toBe(false);
    expect(await db.select().from(s.files)).toHaveLength(2);
  });
});
