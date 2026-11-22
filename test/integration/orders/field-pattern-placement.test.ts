// Placing an order checks a field's value against its stored pattern only when the pattern is in the supported form (decision 051): a stored
// pattern outside the form is not run, so the field has no pattern and the order is placed at once. Real application, Postgres and Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { json, ordersWorld, portalFor, type OrdersWorld } from '../../support/orders';

let t: TestApp;
let world: OrdersWorld;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** Writes the pattern of the `username` field of the server service straight into the database (as a row stored before the rule). */
async function storePattern(regex: string): Promise<void> {
  await world.db.update(s.serviceFields).set({ regex }).where(eq(s.serviceFields.serviceId, world.server.serviceId));
}

describe('POST /client/orders with a stored field pattern', () => {
  it('places an order at once when a stored pattern is outside the supported form: the field has no pattern', async () => {
    await storePattern('^(a+)+$');
    const portal = await portalFor(t, world.merchant.id);
    const started = performance.now();
    const res = await portal.post('/client/orders', {
      serviceId: world.server.serviceId,
      inputs: { username: `${'a'.repeat(30)}!` },
    });
    expect(res.statusCode).toBe(201);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(json(res).orders[0]).toMatchObject({ inputs: { username: `${'a'.repeat(30)}!` } });
  });

  it('still refuses a value its supported pattern does not match', async () => {
    await storePattern('^[a-z]{3}$');
    const portal = await portalFor(t, world.merchant.id);
    const refused = await portal.post('/client/orders', {
      serviceId: world.server.serviceId,
      inputs: { username: 'ab1' },
    });
    expect(refused.statusCode).toBe(422);
    expect(json(refused).errors).toEqual([
      expect.objectContaining({ field: 'inputs.username', code: 'invalid_format' }),
    ]);
    const accepted = await portal.post('/client/orders', {
      serviceId: world.server.serviceId,
      inputs: { username: 'abc' },
    });
    expect(accepted.statusCode).toBe(201);
  });
});
