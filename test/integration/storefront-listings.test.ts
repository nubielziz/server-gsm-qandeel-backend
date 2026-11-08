// Integration tests of the storefront listing routes (feature 15): list with the joined figures, filters and counts, show,
// create (slug, locks, duplicates, races), the isListed switch and the retail price (floor, locks, disabled service), audit,
// the price version and permissions. Rules: B53, b2c-7, catalog-3, catalog-12.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { RetailPrices } from '../../src/modules/catalog';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { TestClock } from '../support/clock';
import { eventually } from '../support/infra';
import { catalogVersionOf } from '../support/pricing';
import {
  insertCustomerRow,
  insertListingRow,
  insertRetailPrice,
  insertStoreOrder,
  listingWorld,
} from '../support/storefront';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['storefront:*'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const retailRow = async (serviceId: number) =>
  (await testDb()).db.select().from(s.serviceGroupPrices).where(eq(s.serviceGroupPrices.serviceId, serviceId));

describe('GET /admin/service-listings', () => {
  it('joins the service, the retail price, the storefront floor, the margin and the 30-day storefront sales', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const id = await insertListingRow(db, world.att, {
      slug: 'atandt-usa-premier-unlock',
      publicTitle: 'AT&T USA Premier Unlock',
      isListed: true,
      isFeatured: true,
    });
    await insertRetailPrice(db, world.att, world.groups.retail, '25.9900');
    const customer = await insertCustomerRow(db);
    // Counted: two non-rejected storefront orders inside the window. Not counted: a rejected one, one older than 30 days,
    // and a merchant's order.
    await insertStoreOrder(db, world.att, customer, { totalPrice: '25.9900', unitPrice: '25.9900' });
    await insertStoreOrder(db, world.att, customer, {
      totalPrice: '25.9900',
      unitPrice: '25.9900',
      status: 'completed',
    });
    await insertStoreOrder(db, world.att, customer, { status: 'rejected' });
    await insertStoreOrder(db, world.att, customer, { placedAt: new Date(clock.nowMs() - 31 * 86_400_000) });

    const res = await admin.get('/admin/service-listings');
    expect(res.status).toBe(200);
    expect(res.total).toBe(1);
    expect(res.body).toEqual([
      {
        id,
        serviceId: world.att,
        locale: 'en',
        slug: 'atandt-usa-premier-unlock',
        publicTitle: 'AT&T USA Premier Unlock',
        isListed: true,
        isFeatured: true,
        service: {
          id: world.att,
          name: 'AT&T USA Premier Unlock',
          code: 'IMEI-ATT-USA',
          basePrice: '17.2800',
          cost: '13.5000',
        },
        retailPrice: '25.9900',
        // max(round(17.28 x 1.10, 2), 13.50 + 0.81) = max(19.01, 14.31)
        floorPrice: '19.0100',
        // (25.99 - 13.50) / 25.99 x 100
        marginPct: '48.0569',
        orders30d: 2,
        revenue30d: '51.9800',
        locked: false,
        lockedReason: null,
      },
    ]);
  });

  it('sends a null retail price and margin when none is set, and a cheap service floor above the 10 % markup', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    await insertListingRow(db, world.check, { publicTitle: 'iCloud check' });
    const [row] = (await admin.get('/admin/service-listings')).body;
    // round(0.13 x 1.10, 2) = 0.14 against cost 0.08 + default minimum profit 0.02 = 0.10
    expect(row).toMatchObject({
      retailPrice: null,
      marginPct: null,
      floorPrice: '0.1400',
      orders30d: 0,
      revenue30d: '0.0000',
    });
  });

  it('uses the effective cost for the floor, so a supplier cost rise lifts floorPrice, cost and the margin together', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    await db.update(s.services).set({ effectiveCost: '19.0000' }).where(eq(s.services.id, world.att));
    await insertListingRow(db, world.att);
    await insertRetailPrice(db, world.att, world.groups.retail, '25.0000');
    const [row] = (await admin.get('/admin/service-listings')).body;
    // cost 19.00 + own minimum profit 0.81 = 19.81 beats the 10 % markup (19.01)
    expect(row.service.cost).toBe('19.0000');
    expect(row.floorPrice).toBe('19.8100');
    expect(row.marginPct).toBe('24.0000');
  });

  it('locks a service whose category excludes the retail group (B2B only) or that is disabled, and filters by locked', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const b2b = await insertCategory(db, { name: 'High risk', allowedGroupIds: [world.groups.standard] });
    const removal = await insertService(db, b2b, { name: 'MDM removal', code: 'IMEI-MDM-PRM' });
    const offToo = await insertCategory(db, {
      name: 'Retail too',
      allowedGroupIds: [world.groups.standard, world.groups.retail],
    });
    const open = await insertService(db, offToo, { name: 'Open service', code: 'IMEI-OPEN' });
    const disabled = await insertService(db, world.categoryId, {
      name: 'Dead service',
      code: 'IMEI-DEAD',
      status: 'disabled',
    });
    await insertListingRow(db, world.att, { publicTitle: 'A first' });
    const lockedId = await insertListingRow(db, removal, { publicTitle: 'B removal' });
    await insertListingRow(db, open, { publicTitle: 'C open' });
    const disabledId = await insertListingRow(db, disabled, { publicTitle: 'D dead' });

    const all = await admin.get('/admin/service-listings');
    expect(all.body.map((r: { publicTitle: string; locked: boolean }) => [r.publicTitle, r.locked])).toEqual([
      ['A first', false],
      ['B removal', true],
      ['C open', false],
      ['D dead', true],
    ]);
    expect(all.body[1].lockedReason).toBe('B2B only: the category High risk is not offered to storefront customers');
    expect(all.body[3].lockedReason).toBe('Service disabled');

    const locked = await admin.get('/admin/service-listings?locked=true');
    expect(locked.body.map((r: { id: number }) => r.id)).toEqual([lockedId, disabledId]);
    expect(locked.total).toBe(2);
    expect((await admin.get('/admin/service-listings?locked=false')).total).toBe(2);
    // The stats of the tab: not listed and not locked.
    expect((await admin.get('/admin/service-listings?isListed=false&locked=false&_start=0&_end=1')).total).toBe(2);
  });

  it('keeps the SQL filter and the row flag in step over every category and status combination', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const { standard, retail } = world.groups;
    const lists: Array<number[]> = [[], [retail], [standard], [standard, retail]];
    for (const [index, allowedGroupIds] of lists.entries()) {
      const category = await insertCategory(db, { name: `Category ${index}`, allowedGroupIds });
      for (const status of ['active', 'disabled'] as const) {
        const service = await insertService(db, category, {
          name: `S ${index} ${status}`,
          code: `S-${index}-${status}`,
          status,
        });
        await insertListingRow(db, service, { publicTitle: `L ${index} ${status}` });
      }
    }
    const all = (await admin.get('/admin/service-listings?_start=0&_end=100')).body as Array<{
      id: number;
      locked: boolean;
    }>;
    const lockedByFilter = (await admin.get('/admin/service-listings?locked=true&_start=0&_end=100')).body as Array<{
      id: number;
    }>;
    const unlockedByFilter = (await admin.get('/admin/service-listings?locked=false&_start=0&_end=100')).body as Array<{
      id: number;
    }>;
    expect(all).toHaveLength(8);
    expect(lockedByFilter.map((r) => r.id).sort()).toEqual(
      all
        .filter((r) => r.locked)
        .map((r) => r.id)
        .sort(),
    );
    expect(unlockedByFilter.map((r) => r.id).sort()).toEqual(
      all
        .filter((r) => !r.locked)
        .map((r) => r.id)
        .sort(),
    );
    // Open: the active service of a category with no group list, of one that names the retail group, and of one that lists both.
    expect(unlockedByFilter).toHaveLength(3);
  });

  it('filters by isListed, searches title, slug, service name and code, sorts and pages with an exact total', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    await insertListingRow(db, world.att, { publicTitle: 'Zeta', slug: 'zeta', isListed: true });
    await insertListingRow(db, world.check, { publicTitle: 'Alpha', slug: 'alpha', isListed: false });
    expect(
      (await admin.get('/admin/service-listings?isListed=true')).body.map((r: { slug: string }) => r.slug),
    ).toEqual(['zeta']);
    expect((await admin.get('/admin/service-listings?q=ICL-CHK')).body.map((r: { slug: string }) => r.slug)).toEqual([
      'alpha',
    ]);
    expect((await admin.get('/admin/service-listings?q=premier')).total).toBe(1);
    expect((await admin.get('/admin/service-listings?q=zet')).total).toBe(1);
    const sorted = await admin.get('/admin/service-listings?_sort=publicTitle&_order=desc&_start=0&_end=1');
    expect(sorted.body.map((r: { slug: string }) => r.slug)).toEqual(['zeta']);
    expect(sorted.total).toBe(2);
    expect((await admin.get('/admin/service-listings?_sort=retailPrice')).status).toBe(422);
  });

  it('leaves out the listings of an archived service (catalog-3)', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    await insertListingRow(db, world.att);
    const gone = await insertListingRow(db, world.check);
    await db
      .update(s.services)
      .set({ status: 'disabled', archivedAt: new Date() })
      .where(eq(s.services.id, world.check));
    const res = await admin.get('/admin/service-listings');
    expect(res.total).toBe(1);
    expect((await admin.get(`/admin/service-listings/${gone}`)).status).toBe(404);
  });

  it('needs storefront:read', async () => {
    const other = await adminWith(t, ['legal:read']);
    expect((await other.get('/admin/service-listings')).status).toBe(403);
    expect((await admin.anonymous('GET', '/admin/service-listings')).status).toBe(401);
  });
});

describe('GET /admin/service-listings/:id', () => {
  it('shows one listing and answers 404 for an unknown id', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const id = await insertListingRow(db, world.att, { publicTitle: 'Premier' });
    expect((await admin.get(`/admin/service-listings/${id}`)).body).toMatchObject({
      id,
      publicTitle: 'Premier',
      floorPrice: '19.0100',
    });
    const missing = await admin.get('/admin/service-listings/999999');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });
});

describe('the figures of a listing whose service is archived meanwhile', () => {
  it('leaves the listing out of a list and answers 404 for it, never a 500', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const gone = await insertListingRow(db, world.att, { slug: 'gone', isListed: true });
    const kept = await insertListingRow(db, world.check, { slug: 'kept' });
    // The service is archived after the rows were read and before the quotes are: the quote of that service is absent.
    const retail = t.app.get(RetailPrices);
    const real = retail.quotes.bind(retail);
    const spy = spyOn(retail, 'quotes').mockImplementation(async (executor, serviceIds, at) => {
      const quotes = await real(executor, serviceIds, at);
      quotes.delete(world.att);
      return quotes;
    });
    try {
      const list = await admin.get('/admin/service-listings?_start=0&_end=10');
      expect(list.status).toBe(200);
      expect(list.body.map((row: { id: number }) => row.id)).toEqual([kept]);
      expect((await admin.get(`/admin/service-listings/${gone}`)).status).toBe(404);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('POST /admin/service-listings', () => {
  it('creates a listing that is not on the site yet, makes the slug from the title and audits it', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const res = await admin.post('/admin/service-listings', {
      serviceId: world.att,
      locale: 'en',
      publicTitle: '  AT&T USA Premier Unlock ',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      serviceId: world.att,
      locale: 'en',
      slug: 'atandt-usa-premier-unlock',
      publicTitle: 'AT&T USA Premier Unlock',
      isListed: false,
      isFeatured: false,
      retailPrice: null,
      locked: false,
    });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      actorId: admin.staffId,
      action: 'created listing for',
      entityType: 'listing',
      entityId: res.body.id,
      entityLabel: 'AT&T USA Premier Unlock',
    });
  });

  it('keeps a typed slug, allows the same service in another language and refuses a slug that is not lower-case words', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const first = await admin.post('/admin/service-listings', {
      serviceId: world.att,
      locale: 'en',
      publicTitle: 'Premier',
      slug: 'premier-unlock',
    });
    expect(first.body.slug).toBe('premier-unlock');
    expect(
      (
        await admin.post('/admin/service-listings', {
          serviceId: world.att,
          locale: 'ar',
          publicTitle: 'بريميير',
          slug: 'premier-unlock',
        })
      ).status,
    ).toBe(201);
    const bad = await admin.post('/admin/service-listings', {
      serviceId: world.check,
      locale: 'en',
      publicTitle: 'x',
      slug: 'Not A Slug',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual([expect.objectContaining({ field: 'slug' })]);
    const noLatin = await admin.post('/admin/service-listings', {
      serviceId: world.check,
      locale: 'ar',
      publicTitle: 'عنوان',
    });
    expect(noLatin.status).toBe(422);
    expect(noLatin.body.errors[0].field).toBe('slug');
  });

  it('answers 409 LISTING_EXISTS for the same service and language, and for a slug used in the language', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    await insertListingRow(db, world.att, { slug: 'taken' });
    const sameService = await admin.post('/admin/service-listings', {
      serviceId: world.att,
      locale: 'en',
      publicTitle: 'Again',
    });
    expect(sameService.status).toBe(409);
    expect(sameService.body).toMatchObject({
      code: 'LISTING_EXISTS',
      errors: [expect.objectContaining({ field: 'serviceId' })],
    });
    const sameSlug = await admin.post('/admin/service-listings', {
      serviceId: world.check,
      locale: 'en',
      publicTitle: 'Taken',
      slug: 'taken',
    });
    expect(sameSlug.status).toBe(409);
    expect(sameSlug.body).toMatchObject({
      code: 'LISTING_EXISTS',
      errors: [expect.objectContaining({ field: 'slug' })],
    });
  });

  it('maps a race on the same listing to 409, never 500', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        admin.post('/admin/service-listings', { serviceId: world.att, locale: 'en', publicTitle: 'Racing' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'LISTING_EXISTS')).toBe(true);
  });

  it('answers 422 on serviceId for an unknown or archived service, and 409 LISTING_LOCKED for B2B-only and disabled services', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const unknown = await admin.post('/admin/service-listings', {
      serviceId: 999999,
      locale: 'en',
      publicTitle: 'Nothing',
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0].field).toBe('serviceId');

    await db
      .update(s.services)
      .set({ status: 'disabled', archivedAt: new Date() })
      .where(eq(s.services.id, world.check));
    expect(
      (await admin.post('/admin/service-listings', { serviceId: world.check, locale: 'en', publicTitle: 'Gone' }))
        .status,
    ).toBe(422);

    const b2b = await insertCategory(db, { name: 'High risk', allowedGroupIds: [world.groups.standard] });
    const removal = await insertService(db, b2b, { name: 'MDM removal', code: 'IMEI-MDM-PRM' });
    const locked = await admin.post('/admin/service-listings', {
      serviceId: removal,
      locale: 'en',
      publicTitle: 'MDM',
    });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('LISTING_LOCKED');
    expect(locked.body.detail).toBe(
      'B2B only: the category High risk is not offered to storefront customers. This service cannot be listed publicly.',
    );
    const off = await insertService(db, world.categoryId, { name: 'Dead', code: 'IMEI-DEAD', status: 'disabled' });
    const dead = await admin.post('/admin/service-listings', { serviceId: off, locale: 'en', publicTitle: 'Dead' });
    expect(dead.body).toMatchObject({
      code: 'LISTING_LOCKED',
      detail: 'Service disabled. This service cannot be listed publicly.',
    });
  });

  it('refuses a blank title and an unknown language on the field', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const res = await admin.post('/admin/service-listings', { serviceId: world.att, locale: 'fr', publicTitle: '   ' });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['locale', 'publicTitle']);
  });

  it('needs storefront:create', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const reader = await adminWith(t, ['storefront:read']);
    expect(
      (await reader.post('/admin/service-listings', { serviceId: world.att, locale: 'en', publicTitle: 'x' })).status,
    ).toBe(403);
    expect(
      (
        await admin.withoutCsrf('POST', '/admin/service-listings', {
          serviceId: world.att,
          locale: 'en',
          publicTitle: 'x',
        })
      ).status,
    ).toBe(403);
  });
});

describe('PATCH /admin/service-listings/:id (the switch)', () => {
  it('switches a listing on and off and audits both with the demo phrases', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const id = await insertListingRow(db, world.att);
    const on = await admin.patch(`/admin/service-listings/${id}`, { isListed: true });
    expect(on.status).toBe(200);
    expect(on.body.isListed).toBe(true);
    const off = await admin.patch(`/admin/service-listings/${id}`, { isListed: false });
    expect(off.body.isListed).toBe(false);
    const audit = await auditRows();
    expect(audit.map((a) => [a.action, a.entityType, a.entityId, a.entityLabel])).toEqual([
      ['listed on storefront', 'listing', id, 'AT&T USA Premier Unlock'],
      ['unlisted from storefront', 'listing', id, 'AT&T USA Premier Unlock'],
    ]);
    expect(audit[0]?.before).toEqual({ isListed: false });
    expect(audit[0]?.after).toEqual({ isListed: true });
  });

  it('audits the value the row had under the service lock, not the one read before it', async () => {
    const { db, pool } = await testDb();
    const world = await listingWorld(db);
    const id = await insertListingRow(db, world.att);
    let pending: ReturnType<AdminApi['patch']> | undefined;
    await db.transaction(async (tx) => {
      // Hold the service row, as a concurrent writer of the same service would.
      await tx.execute(sql`select id from services where id = ${world.att} for update`);
      pending = admin.patch(`/admin/service-listings/${id}`, { isListed: true });
      // The request has read the listing (switched off) and now waits for the service lock.
      await eventually(async () => {
        const { rows } = await pool.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
        );
        return rows[0]!.n > 0 ? true : undefined;
      });
      // The other writer switches the listing on and commits before the request gets the lock.
      await tx.update(s.serviceListings).set({ isListed: true }).where(eq(s.serviceListings.id, id));
    });
    const res = await pending!;
    expect(res.status).toBe(200);
    const [audit] = await auditRows();
    expect(audit).toMatchObject({ action: 'listed on storefront', entityId: id });
    expect(audit?.before).toEqual({ isListed: true });
    expect(audit?.after).toEqual({ isListed: true });
  });

  it('refuses switching on a disabled service (409 SERVICE_DISABLED) and a B2B-only one (409 LISTING_LOCKED), but allows switching off', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const id = await insertListingRow(db, world.att, { isListed: true });
    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, world.att));
    const disabled = await admin.patch(`/admin/service-listings/${id}`, { isListed: true });
    expect(disabled.status).toBe(409);
    expect(disabled.body).toMatchObject({
      code: 'SERVICE_DISABLED',
      detail: 'AT&T USA Premier Unlock is disabled. Enable the service first.',
    });
    // Switching off is always allowed, so a disabled service can be taken off the site.
    expect((await admin.patch(`/admin/service-listings/${id}`, { isListed: false })).body.isListed).toBe(false);

    const b2b = await insertCategory(db, { name: 'High risk', allowedGroupIds: [world.groups.standard] });
    const removal = await insertService(db, b2b, { name: 'MDM removal', code: 'IMEI-MDM-PRM' });
    const lockedId = await insertListingRow(db, removal);
    const locked = await admin.patch(`/admin/service-listings/${lockedId}`, { isListed: true });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('LISTING_LOCKED');
    expect((await admin.patch(`/admin/service-listings/${lockedId}`, { isListed: false })).status).toBe(200);
  });

  it('answers 404 for an unknown listing and for a listing whose service is archived, and 422 for an empty body', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    expect((await admin.patch('/admin/service-listings/999999', { isListed: true })).status).toBe(404);
    const id = await insertListingRow(db, world.att);
    expect((await admin.patch(`/admin/service-listings/${id}`, {})).status).toBe(422);
    await db.update(s.services).set({ status: 'disabled', archivedAt: new Date() }).where(eq(s.services.id, world.att));
    expect((await admin.patch(`/admin/service-listings/${id}`, { isListed: true })).status).toBe(404);
  });

  it('needs storefront:update', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const id = await insertListingRow(db, world.att);
    const reader = await adminWith(t, ['storefront:read', 'storefront:create']);
    expect((await reader.patch(`/admin/service-listings/${id}`, { isListed: true })).status).toBe(403);
  });
});

describe('PATCH /admin/service-listings/:id (the retail price)', () => {
  it('writes the retail group price, works the figures out again, audits it and moves the catalog price version', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const id = await insertListingRow(db, world.att);
    const version = await catalogVersionOf(t);
    const res = await admin.patch(`/admin/service-listings/${id}`, { retailPrice: '25.9900' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ retailPrice: '25.9900', floorPrice: '19.0100', marginPct: '48.0569' });
    expect(await retailRow(world.att)).toEqual([
      expect.objectContaining({ groupId: world.groups.retail, price: '25.9900' }),
    ]);
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'changed retail price of',
      entityType: 'listing',
      entityId: id,
      entityLabel: 'AT&T USA Premier Unlock',
    });
    expect(audit?.before).toEqual({ retailPrice: null });
    expect(audit?.after).toEqual({ retailPrice: '25.9900' });
    expect(await catalogVersionOf(t)).not.toBe(version);

    const again = await admin.patch(`/admin/service-listings/${id}`, { retailPrice: '27.5000' });
    expect(again.body.retailPrice).toBe('27.5000');
    expect((await retailRow(world.att)).length).toBe(1);
    expect((await auditRows())[1]?.before).toEqual({ retailPrice: '25.9900' });
  });

  it('applies to the listing of every language of the service', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const en = await insertListingRow(db, world.att, { locale: 'en', slug: 'en' });
    const ar = await insertListingRow(db, world.att, { locale: 'ar', slug: 'ar' });
    await admin.patch(`/admin/service-listings/${en}`, { retailPrice: '25.9900' });
    expect((await admin.get(`/admin/service-listings/${ar}`)).body.retailPrice).toBe('25.9900');
  });

  it('accepts a price exactly at the floor and refuses one under it, naming the floor on retailPrice', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const id = await insertListingRow(db, world.att);
    const under = await admin.patch(`/admin/service-listings/${id}`, { retailPrice: '19.0099' });
    expect(under.status).toBe(422);
    expect(under.body.errors).toEqual([
      expect.objectContaining({ field: 'retailPrice', message: 'Below the storefront floor of $19.01.' }),
    ]);
    expect(await retailRow(world.att)).toEqual([]);
    expect((await admin.patch(`/admin/service-listings/${id}`, { retailPrice: '19.0100' })).status).toBe(200);
  });

  it('uses the same floor as the group-prices route, so the two writers never disagree', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const id = await insertListingRow(db, world.att);
    const catalogAdmin = await adminWith(t, ['pricing:*', 'catalog:read']);
    const viaGroups = await catalogAdmin.put(`/admin/services/${world.att}/group-prices`, {
      prices: [{ groupId: world.groups.retail, price: '19.0099' }],
    });
    expect(viaGroups.status).toBe(422);
    expect((await admin.patch(`/admin/service-listings/${id}`, { retailPrice: '19.0099' })).status).toBe(422);
    expect(
      (
        await catalogAdmin.put(`/admin/services/${world.att}/group-prices`, {
          prices: [{ groupId: world.groups.retail, price: '19.0100' }],
        })
      ).status,
    ).toBe(200);
    expect((await admin.get(`/admin/service-listings/${id}`)).body.retailPrice).toBe('19.0100');
  });

  it('refuses a price of zero or less on retailPrice and answers 422 for a price that is not a 4-decimal amount', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const id = await insertListingRow(db, world.att);
    const zero = await admin.patch(`/admin/service-listings/${id}`, { retailPrice: '0.0000' });
    expect(zero.status).toBe(422);
    expect(zero.body.errors[0]).toMatchObject({ field: 'retailPrice', message: 'Enter a price greater than zero.' });
    expect((await admin.patch(`/admin/service-listings/${id}`, { retailPrice: '-5.0000' })).status).toBe(422);
    expect((await admin.patch(`/admin/service-listings/${id}`, { retailPrice: '25.99' })).status).toBe(422);
  });

  it('refuses to price a service that can never be public (409 LISTING_LOCKED)', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const b2b = await insertCategory(db, { name: 'High risk', allowedGroupIds: [world.groups.standard] });
    const removal = await insertService(db, b2b, {
      name: 'MDM removal',
      code: 'IMEI-MDM-PRM',
      basePrice: '30.0000',
      cost: '24.0000',
      effectiveCost: '24.0000',
    });
    const id = await insertListingRow(db, removal);
    const res = await admin.patch(`/admin/service-listings/${id}`, { retailPrice: '40.0000' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LISTING_LOCKED');
    expect(await retailRow(removal)).toEqual([]);
  });

  it('applies nothing when one of two fields is refused', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const id = await insertListingRow(db, world.att);
    const res = await admin.patch(`/admin/service-listings/${id}`, { isListed: true, retailPrice: '1.0000' });
    expect(res.status).toBe(422);
    expect((await admin.get(`/admin/service-listings/${id}`)).body.isListed).toBe(false);
    expect(await auditRows()).toEqual([]);
  });

  it('applies both fields of one request and writes one audit entry for each', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const id = await insertListingRow(db, world.att);
    const res = await admin.patch(`/admin/service-listings/${id}`, { isListed: true, retailPrice: '25.9900' });
    expect(res.body).toMatchObject({ isListed: true, retailPrice: '25.9900' });
    expect((await auditRows()).map((a) => a.action)).toEqual(['changed retail price of', 'listed on storefront']);
  });

  it('keeps parallel price writes consistent: the last committed price is the one stored, with one row', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const id = await insertListingRow(db, world.att);
    const prices = ['20.0000', '21.0000', '22.0000', '23.0000'];
    const results = await Promise.all(
      prices.map((retailPrice) => admin.patch(`/admin/service-listings/${id}`, { retailPrice })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const rows = await retailRow(world.att);
    expect(rows).toHaveLength(1);
    expect(prices).toContain(rows[0]!.price);
  });
});
