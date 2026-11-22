// Integration tests of the storefront receipt upload (feature 21, plan § 7.1 route 9): a PDF, JPEG or PNG of the signed-in customer, stored
// as the customer's file; another type, an empty file, a declared body over 5 MiB, no session and no CSRF token are refused.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { multipartRequest } from '../../support/machine-orders';
import {
  STORE_CSRF_COOKIE,
  STORE_ORIGIN,
  STORE_SESSION_COOKIE,
  StoreClient,
  clearStoreRateLimits,
  makeCustomer,
} from '../../support/store';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { SHOP_ORIGINS: STORE_ORIGIN } });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** A multipart upload with the store client's cookies, origin and (unless told otherwise) its CSRF token. */
async function upload(store: StoreClient, name: string, type: string, bytes: Uint8Array, csrf = true) {
  const form = new FormData();
  form.set('file', new File([bytes], name, { type }));
  const headers: Record<string, string> = { origin: STORE_ORIGIN };
  const cookies = [STORE_SESSION_COOKIE, STORE_CSRF_COOKIE].flatMap((cookie) => {
    const value = store.cookie(cookie);
    return value === undefined ? [] : [`${cookie}=${value}`];
  });
  if (cookies.length > 0) headers.cookie = cookies.join('; ');
  if (csrf && store.csrf !== undefined) headers['x-csrf-token'] = store.csrf;
  return multipartRequest(t, '/store/v1/files', form, headers, '127.0.0.1');
}

async function signedIn() {
  const customer = await makeCustomer(t);
  const store = new StoreClient(t);
  expect((await store.login(customer.email)).statusCode).toBe(200);
  return { customer, store };
}

describe('POST /store/v1/files', () => {
  it('stores a PDF as the customer’s file', async () => {
    const { customer, store } = await signedIn();
    const res = await upload(store, '../receipt.pdf', 'application/pdf', new TextEncoder().encode('%PDF-1.4 receipt'));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ filename: 'receipt.pdf', mime: 'application/pdf', size: 16 });
    const { db } = await testDb();
    const [row] = await db.select().from(s.files).where(eq(s.files.id, res.json().id));
    expect(row).toMatchObject({ ownerType: 'customer', ownerId: customer.id });
  });

  it('refuses another media type and an empty file', async () => {
    const { store } = await signedIn();
    const text = await upload(store, 'notes.txt', 'text/plain', new TextEncoder().encode('hello'));
    expect(text.statusCode).toBe(422);
    expect(text.json().errors[0]).toMatchObject({ field: 'file', code: 'type' });
    const empty = await upload(store, 'empty.png', 'image/png', new Uint8Array());
    expect(empty.statusCode).toBe(422);
  });

  it('refuses a declared body over 5 MiB before it is read', async () => {
    const { store } = await signedIn();
    const res = await upload(store, 'big.jpg', 'image/jpeg', new Uint8Array(5 * 1024 * 1024 + 70 * 1024));
    expect(res.statusCode).toBe(413);
  });

  it('needs a session and the CSRF token', async () => {
    const anonymous = new StoreClient(t);
    expect((await upload(anonymous, 'r.pdf', 'application/pdf', new Uint8Array([1]))).statusCode).toBe(401);
    const { store } = await signedIn();
    expect((await upload(store, 'r.pdf', 'application/pdf', new Uint8Array([1]), false)).statusCode).toBe(403);
  });
});
