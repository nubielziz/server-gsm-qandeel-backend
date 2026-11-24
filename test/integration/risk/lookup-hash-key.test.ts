// The key of stored lookups (decision 054): with LOOKUP_HASH_KEY set, the blocklist, the inventory duplicates and the unsubscribe links are
// keyed with it, not with the credential pepper, and a blocked e-mail is still refused at checkout.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DEV_DEFAULTS } from '@src/config';
import { TokenService, hashToken } from '@src/infra/crypto';
import { type Database, schema as s } from '@src/infra/db';
import { inventoryCodeHashInput } from '@src/modules/catalog/domain/inventory-codes';
import { marketingUnsubscribeToken, parseMarketingUnsubscribeToken } from '@src/modules/platform';
import { blockHashInput } from '@src/modules/risk/domain/blocklist-values';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertCategory, insertService } from '../../support/catalog';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { freshClientIp } from '../../support/pipeline-routes';
import { blocklistRows } from '../../support/risk';
import { APPLE_IMEI, TURNSTILE_HEADERS, storefrontWorld } from '../../support/storefront';

const KEY = 'k'.repeat(40);
let t: TestApp;
let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ env: { LOOKUP_HASH_KEY: KEY } });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe('stored lookups are keyed with LOOKUP_HASH_KEY', () => {
  it('a blocklist entry is stored under the lookup key and still refuses a checkout with that e-mail', async () => {
    const staff = await adminWith(t, ['risk:read', 'risk:create']);
    expect(
      (await staff.post('/admin/blocklist', { kind: 'email', value: 'sam@mail.example', reason: 'Chargeback' })).status,
    ).toBe(201);
    const [row] = await blocklistRows(db);
    expect(row!.valueHash).toBe(hashToken(KEY, blockHashInput('email', 'sam@mail.example')));
    expect(row!.valueHash).not.toBe(hashToken(DEV_DEFAULTS.tokenPepper, blockHashInput('email', 'sam@mail.example')));

    const world = await storefrontWorld(db);
    const res = await t.app.inject({
      method: 'POST',
      url: '/store/v1/checkout-sessions',
      headers: { 'user-agent': 'Mozilla/5.0 (test)', ...TURNSTILE_HEADERS },
      remoteAddress: freshClientIp(),
      payload: { serviceId: world.icloud.serviceId, email: 'sam@mail.example', country: 'GB', imei: APPLE_IMEI },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('ACCOUNT_SUSPENDED');
  });

  it('an inventory import stores the code hash under the lookup key', async () => {
    const admin = await adminWith(t, ['inventory:*', 'catalog:*']);
    const serviceId = await insertService(db, await insertCategory(db, { type: 'server' }), { type: 'server' });
    const res = await admin.post(`/admin/services/${serviceId}/inventory/import`, { codes: ['UT-1000-A1B2'] });
    expect(res.status).toBe(200);
    const [code] = await db.select().from(s.inventoryCodes);
    expect(code!.codeHash).toBe(hashToken(KEY, inventoryCodeHashInput('UT-1000-A1B2')));
  });

  it('an unsubscribe link made by this app verifies only with the lookup key', () => {
    const tokens = t.app.get(TokenService);
    const token = marketingUnsubscribeToken(tokens, 42);
    expect(parseMarketingUnsubscribeToken(tokens, token)).toEqual({ kind: 'account', id: 42 });
    const pepperOnly = new TokenService({
      security: { tokenPepper: DEV_DEFAULTS.tokenPepper, lookupHashKey: DEV_DEFAULTS.tokenPepper },
    } as never);
    expect(parseMarketingUnsubscribeToken(pepperOnly, token)).toBeUndefined();
  });
});
