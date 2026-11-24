// Constraints the map and the decisions imply (decision 027): the buyer and door checks of orders (decision 064), case-insensitive
// unique emails (one partition for accounts with a login, one for guests), enumeration CHECKs, partial unique keys and identity ids.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { makeAccount } from '../../support/accounts';
import { ORDER_DEFAULTS, insertOrder, insertOrderParents, insertUsd } from '../../support/fixtures';
import { closeTestDb, pgErrorOf, resetDb, testDb } from '../../support/db';

beforeEach(resetDb);
afterAll(closeTestDb);

describe('orders', () => {
  it('belong to one account, and the old merchant column is set exactly for the doors that are not the shop', async () => {
    const { db } = await testDb();
    const parents = await insertOrderParents(db);
    const retail = await makeAccount({ rank: 'retail', db });
    const base = { ...ORDER_DEFAULTS, serviceId: parents.serviceId };

    await db.insert(s.orders).values({ ...base, accountId: parents.clientId, legacyClientId: parents.clientId });
    await db.insert(s.orders).values({ ...base, source: 'store', accountId: retail.id });

    const storeWithMerchant = await pgErrorOf(
      db.insert(s.orders).values({ ...base, source: 'store', accountId: retail.id, legacyClientId: parents.clientId }),
    );
    expect(storeWithMerchant.code).toBe('23514');
    expect(['orders_door_check', 'orders_hold_buyer_check']).toContain(storeWithMerchant.constraint ?? '');
    const portalWithout = await pgErrorOf(db.insert(s.orders).values({ ...base, accountId: parents.clientId }));
    expect(portalWithout.constraint).toBe('orders_door_check');
    const otherMerchant = await pgErrorOf(
      db.insert(s.orders).values({ ...base, accountId: retail.id, legacyClientId: parents.clientId }),
    );
    expect(otherMerchant.constraint).toBe('orders_hold_buyer_check');
    const nobody = await pgErrorOf(
      db.execute(sql`insert into orders (service_id, type, source, unit_price, total_price, currency)
      values (${parents.serviceId}, 'imei', 'store', 1, 1, 'USD')`),
    );
    expect(nobody.code).toBe('23502');
  });

  it('refuse a quantity below one and a status outside the state machine', async () => {
    const { db } = await testDb();
    const parents = await insertOrderParents(db);
    const base = {
      ...ORDER_DEFAULTS,
      serviceId: parents.serviceId,
      accountId: parents.clientId,
      legacyClientId: parents.clientId,
    };
    expect((await pgErrorOf(db.insert(s.orders).values({ ...base, quantity: 0 }))).constraint).toBe(
      'orders_quantity_check',
    );
    const outside = await pgErrorOf(db.insert(s.orders).values({ ...base, status: 'cancelled' as never }));
    expect(outside.constraint).toBe('orders_status_check');
  });

  it('start pending and keep a tracking token unique only when present', async () => {
    const { db } = await testDb();
    const parents = await insertOrderParents(db);
    const retail = await makeAccount({ rank: 'retail', db });
    const base = { ...ORDER_DEFAULTS, source: 'store' as const, serviceId: parents.serviceId, accountId: retail.id };
    const [first] = await db
      .insert(s.orders)
      .values({ ...base, publicToken: 'abc' })
      .returning();
    expect(first!.status).toBe('pending');
    expect(first!.dispatchState).toBe('pending');
    await db.insert(s.orders).values({ ...base });
    await db.insert(s.orders).values({ ...base });
    const duplicate = await pgErrorOf(db.insert(s.orders).values({ ...base, publicToken: 'abc' }));
    expect(duplicate.constraint).toBe('orders_public_token_uq');
  });

  it('keep a merchant idempotency key unique per merchant', async () => {
    const { db } = await testDb();
    const parents = await insertOrderParents(db);
    const values = {
      ...ORDER_DEFAULTS,
      serviceId: parents.serviceId,
      accountId: parents.clientId,
      legacyClientId: parents.clientId,
      idempotencyKey: 'idem-1',
    };
    await db.insert(s.orders).values(values);
    expect((await pgErrorOf(db.insert(s.orders).values(values))).constraint).toBe('orders_client_idempotency_uq');
  });
});

describe('unique keys', () => {
  it('treat emails as case-insensitive for staff, and once among accounts with a login and once among guests', async () => {
    const { db } = await testDb();
    const [role] = await db
      .insert(s.roles)
      .values({ name: 'Owner', permissions: ['*'] })
      .returning({ id: s.roles.id });
    await db.insert(s.staffUsers).values({ email: 'Rami@Example.com', name: 'Rami', roleId: role!.id });
    const staff = await pgErrorOf(
      db.insert(s.staffUsers).values({ email: 'rami@example.COM', name: 'Other', roleId: role!.id }),
    );
    expect(staff.code).toBe('23505');
    expect(staff.constraint).toBe('staff_users_email_uq');

    await insertOrderParents(db);
    const merchant = await pgErrorOf(makeAccount({ rank: 'merchant', db, email: 'MERCHANT@example.com' }));
    expect(merchant.code).toBe('23505');
    expect(merchant.constraint).toBe('clients_login_email_uq');
    const username = await pgErrorOf(makeAccount({ rank: 'merchant', db, username: 'MERCHANT' }));
    expect(username.constraint).toBe('clients_username_uq');

    // A guest may share the address of an account with a login (a checkout typed with it), but two guests may not.
    await makeAccount({ rank: 'retail', guest: true, db, email: 'Merchant@Example.com' });
    const guest = await pgErrorOf(makeAccount({ rank: 'retail', guest: true, db, email: 'merchant@EXAMPLE.com' }));
    expect(guest.constraint).toBe('clients_guest_email_uq');
    const retail = await pgErrorOf(makeAccount({ rank: 'retail', db, email: 'merchant@example.COM' }));
    expect(retail.constraint).toBe('clients_login_email_uq');
  });

  it('keep service codes unique ignoring case, and one default and one retail merchant group', async () => {
    const { db } = await testDb();
    await insertOrderParents(db);
    const [category] = await db.select({ id: s.serviceCategories.id }).from(s.serviceCategories);
    const service = {
      categoryId: category!.id,
      type: 'imei' as const,
      name: 'Another',
      fulfillment: 'auto' as const,
      priceMode: 'fixed' as const,
      basePrice: '5.0000',
      duplicateRule: 'allow' as const,
      slaMinutes: 60,
    };
    expect((await pgErrorOf(db.insert(s.services).values({ ...service, code: 'imei-icl-chk' }))).constraint).toBe(
      'services_code_uq',
    );

    expect((await pgErrorOf(db.insert(s.clientGroups).values({ name: 'Other', isDefault: true }))).constraint).toBe(
      'client_groups_single_default_uq',
    );
    await db.insert(s.clientGroups).values({ name: 'Retail', kind: 'b2c_retail' });
    expect(
      (await pgErrorOf(db.insert(s.clientGroups).values({ name: 'Retail 2', kind: 'b2c_retail' }))).constraint,
    ).toBe('client_groups_single_retail_uq');
  });

  it('keep one payment per gateway reference, ignoring payments that have none yet', async () => {
    const { db } = await testDb();
    await insertUsd(db);
    const [gateway] = await db
      .insert(s.paymentGateways)
      .values({ code: 'stripe', driver: 'stripe', name: 'Stripe' })
      .returning({ id: s.paymentGateways.id });
    const buyer = await makeAccount({ rank: 'retail', db });
    const payment = {
      accountId: buyer.id,
      purpose: 'order' as const,
      gatewayId: gateway!.id,
      amount: '10',
      currency: 'USD',
      status: 'captured' as const,
      methodType: 'card' as const,
    };
    await db.insert(s.payments).values([{ ...payment }, { ...payment }]);
    await db.insert(s.payments).values({ ...payment, gatewayTxnId: 'pi_1' });
    expect((await pgErrorOf(db.insert(s.payments).values({ ...payment, gatewayTxnId: 'pi_1' }))).constraint).toBe(
      'payments_gateway_txn_uq',
    );
    expect((await pgErrorOf(db.insert(s.payments).values({ ...payment, amount: '0' }))).constraint).toBe(
      'payments_amount_check',
    );
  });
});

describe('enumerations', () => {
  it('are enforced by a CHECK on the text column', async () => {
    const { db } = await testDb();
    const [role] = await db.insert(s.roles).values({ name: 'Owner' }).returning({ id: s.roles.id });
    const failure = await pgErrorOf(
      db.execute(
        sql`insert into staff_users (email, name, role_id, status) values ('a@example.com', 'A', ${role!.id}, 'bogus')`,
      ),
    );
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('staff_users_status_check');
  });
});

describe('ids and foreign keys', () => {
  it('are generated always: an explicit id needs OVERRIDING SYSTEM VALUE (what the seed does)', async () => {
    const { db } = await testDb();
    const explicit = await pgErrorOf(db.execute(sql`insert into roles (id, name) values (41, 'Forced')`));
    expect(explicit.message).toContain('non-DEFAULT value into column "id"');
    await db.insert(s.roles).overridingSystemValue().values({ id: 41, name: 'Forced' });
    // The identity sequence does not move with an explicit id: the seed syncs it afterwards.
    const [next] = await db.insert(s.roles).values({ name: 'Next' }).returning({ id: s.roles.id });
    expect(next!.id).toBe(1);
  });

  it('restrict deleting a parent that children use, but cascade for dependent configuration', async () => {
    const { db } = await testDb();
    const parents = await insertOrderParents(db);
    await insertOrder(db, parents);
    await db.insert(s.serviceFields).values({ serviceId: parents.serviceId, key: 'imei', label: 'IMEI' });
    const used = await pgErrorOf(db.delete(s.services));
    expect(used.code).toBe('23001'); // restrict_violation: ON DELETE RESTRICT

    await db.delete(s.orders);
    await db.delete(s.services);
    expect(await db.$count(s.serviceFields)).toBe(0);
  });

  it('accepts any JSON value in settings', async () => {
    const { db } = await testDb();
    await db.insert(s.settings).values([
      { key: 'adminAllowlistOnly', value: false },
      { key: 'maintenance', value: { scope: 'store' } },
      { key: 'pricing.price_change_tolerance_percent', value: 10 },
    ]);
    const rows = await db.select().from(s.settings).orderBy(s.settings.key);
    expect(rows.map((row) => row.value)).toEqual([false, { scope: 'store' }, 10]);
  });
});
