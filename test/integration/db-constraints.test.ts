// Constraints the map and the decisions imply (decision 027): the orders one-of check, case-insensitive unique emails,
// enumeration CHECKs, partial unique keys and identity ids.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { ORDER_DEFAULTS, insertOrder, insertOrderParents, insertUsd } from '../support/fixtures';
import { closeTestDb, pgErrorOf, resetDb, testDb } from '../support/db';

beforeEach(resetDb);
afterAll(closeTestDb);

describe('orders', () => {
  it('belong to exactly one buyer: a merchant or a customer', async () => {
    const { db } = await testDb();
    const parents = await insertOrderParents(db);
    const [customer] = await db
      .insert(s.customers)
      .values({ email: 'buyer@example.com' })
      .returning({ id: s.customers.id });
    const base = { ...ORDER_DEFAULTS, serviceId: parents.serviceId };

    await db.insert(s.orders).values({ ...base, clientId: parents.clientId });
    await db.insert(s.orders).values({ ...base, customerId: customer!.id });

    const both = await pgErrorOf(
      db.insert(s.orders).values({ ...base, clientId: parents.clientId, customerId: customer!.id }),
    );
    expect(both.code).toBe('23514');
    expect(both.constraint).toBe('orders_buyer_check');
    const neither = await pgErrorOf(db.insert(s.orders).values(base));
    expect(neither.constraint).toBe('orders_buyer_check');
  });

  it('refuse a quantity below one and a status outside the state machine', async () => {
    const { db } = await testDb();
    const parents = await insertOrderParents(db);
    const base = { ...ORDER_DEFAULTS, ...parents };
    expect((await pgErrorOf(db.insert(s.orders).values({ ...base, quantity: 0 }))).constraint).toBe(
      'orders_quantity_check',
    );
    const outside = await pgErrorOf(db.insert(s.orders).values({ ...base, status: 'cancelled' as never }));
    expect(outside.constraint).toBe('orders_status_check');
  });

  it('start pending and keep a tracking token unique only when present', async () => {
    const { db } = await testDb();
    const parents = await insertOrderParents(db);
    const [customer] = await db
      .insert(s.customers)
      .values({ email: 'buyer@example.com' })
      .returning({ id: s.customers.id });
    const base = { ...ORDER_DEFAULTS, serviceId: parents.serviceId, customerId: customer!.id };
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
    const values = { ...ORDER_DEFAULTS, ...parents, idempotencyKey: 'idem-1' };
    await db.insert(s.orders).values(values);
    expect((await pgErrorOf(db.insert(s.orders).values(values))).constraint).toBe('orders_client_idempotency_uq');
  });
});

describe('unique keys', () => {
  it('treat emails as case-insensitive for staff, merchants and customers', async () => {
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
    const merchant = await pgErrorOf(
      db
        .insert(s.clients)
        .values({ username: 'other', email: 'MERCHANT@example.com', name: 'M', groupId: 1, referralCode: 'R2' }),
    );
    expect(merchant.constraint).toBe('clients_email_uq');
    const username = await pgErrorOf(
      db
        .insert(s.clients)
        .values({ username: 'MERCHANT', email: 'x@example.com', name: 'M', groupId: 1, referralCode: 'R3' }),
    );
    expect(username.constraint).toBe('clients_username_uq');

    await db.insert(s.customers).values({ email: 'Buyer@Example.com' });
    expect((await pgErrorOf(db.insert(s.customers).values({ email: 'buyer@example.com' }))).constraint).toBe(
      'customers_email_uq',
    );
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
      priceMode: 'margin',
      duplicateRule: 'allow',
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
    const payment = {
      purpose: 'order' as const,
      gatewayId: gateway!.id,
      amount: '10',
      currency: 'USD',
      status: 'captured',
      methodType: 'card',
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
      { key: 'imeiRetentionDays', value: 180 },
      { key: 'maintenance', value: { scope: 'store' } },
    ]);
    const rows = await db.select().from(s.settings).orderBy(s.settings.key);
    expect(rows.map((row) => row.value)).toEqual([false, 180, { scope: 'store' }]);
  });
});
