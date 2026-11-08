// The legal documents read and the retail price provider other modules use (features 14a and 15): the version in force a consent
// references (the very version the console's Legal page shows as current), and the retail price and storefront floor of a service.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Money } from '../../src/common/money';
import { RetailPrices } from '../../src/modules/catalog';
import { CurrentLegalDocuments } from '../../src/modules/storefront';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertService } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertLegalRow, insertRetailPrice, listingWorld } from '../support/storefront';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
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

describe('CurrentLegalDocuments', () => {
  it('finds the version in force of a type and language, and a version by id', async () => {
    const { db } = await testDb();
    const legal = t.app.get(CurrentLegalDocuments);
    const current = await insertLegalRow(db, {
      version: '3.2',
      isCurrent: true,
      effectiveFrom: new Date('2026-10-01T09:00:00.000Z'),
    });
    const draft = await insertLegalRow(db, { version: '3.3' });
    expect(await legal.current(db, 'terms', 'en')).toEqual({
      id: current.id,
      type: 'terms',
      locale: 'en',
      version: '3.2',
      effectiveFrom: new Date('2026-10-01T09:00:00.000Z'),
      isCurrent: true,
      requiresReacceptance: false,
    });
    expect(await legal.current(db, 'privacy', 'en')).toBeUndefined();
    expect(await legal.find(db, draft.id)).toMatchObject({ version: '3.3', isCurrent: false, effectiveFrom: null });
    expect(await legal.find(db, 999999)).toBeUndefined();
  });

  it('falls back to English for a language with nothing in force, while the page read stays in one language', async () => {
    const { db } = await testDb();
    const legal = t.app.get(CurrentLegalDocuments);
    const english = await insertLegalRow(db, { version: '3.2', isCurrent: true, effectiveFrom: new Date() });
    // Arabic has only a draft, so nothing is in force in Arabic.
    await insertLegalRow(db, { version: '3.2', locale: 'ar' });
    expect((await legal.current(db, 'terms', 'ar'))?.id).toBe(english.id);
    expect(await legal.currentWithBody(db, 'terms', 'ar')).toBeUndefined();
    expect((await legal.currentWithBody(db, 'terms', 'en'))?.bodyMd).toBe('# Terms');

    // Once Arabic has a version in force, it is the one a consent in Arabic records.
    const arabic = await insertLegalRow(db, {
      version: '3.3',
      locale: 'ar',
      isCurrent: true,
      effectiveFrom: new Date(),
    });
    expect((await legal.current(db, 'terms', 'ar'))?.id).toBe(arabic.id);
    expect((await legal.currentWithBody(db, 'terms', 'ar'))?.id).toBe(arabic.id);
  });

  it('lists every version in force, by type then language', async () => {
    const { db } = await testDb();
    const legal = t.app.get(CurrentLegalDocuments);
    await insertLegalRow(db, { type: 'terms', version: '3.2', isCurrent: true, effectiveFrom: new Date() });
    await insertLegalRow(db, {
      type: 'terms',
      version: '3.2',
      locale: 'ar',
      isCurrent: true,
      effectiveFrom: new Date(),
    });
    await insertLegalRow(db, { type: 'privacy', version: '2.1', isCurrent: true, effectiveFrom: new Date() });
    await insertLegalRow(db, { type: 'privacy', version: '2.2' });
    const current = await legal.listCurrent(db);
    expect(current.map((doc) => `${doc.type}/${doc.locale}/${doc.version}`)).toEqual([
      'privacy/en/2.1',
      'terms/ar/3.2',
      'terms/en/3.2',
    ]);
  });

  it('reads the very version the console shows as current: publishing a draft moves the read at once', async () => {
    const { db } = await testDb();
    const legal = t.app.get(CurrentLegalDocuments);
    const staff = await adminWith(t, ['legal:*']);
    const old = await insertLegalRow(db, {
      version: '3.2',
      isCurrent: true,
      effectiveFrom: new Date('2026-10-01T09:00:00.000Z'),
    });
    const draft = await insertLegalRow(db, { version: '3.3' });
    expect((await legal.current(db, 'terms', 'en'))?.id).toBe(old.id);

    expect((await staff.post(`/admin/legal-documents/${draft.id}/publish`)).status).toBe(200);
    const shown = await staff.get('/admin/legal-documents?isCurrent=true&_start=0&_end=10');
    expect(shown.body.map((row: { id: number }) => row.id)).toEqual([draft.id]);
    expect((await legal.current(db, 'terms', 'en'))?.id).toBe(draft.id);
    expect((await legal.current(db, 'terms', 'en'))?.version).toBe('3.3');
    expect((await legal.currentWithBody(db, 'terms', 'en'))?.id).toBe(draft.id);
    expect((await legal.find(db, old.id))?.isCurrent).toBe(false);
  });
});

describe('RetailPrices', () => {
  it('quotes the cost, the storefront floor and the retail price of live services, and leaves archived ones out', async () => {
    const { db } = await testDb();
    const retail = t.app.get(RetailPrices);
    const world = await listingWorld(db);
    await insertRetailPrice(db, world.att, world.groups.retail, '25.9900');
    const archived = await insertService(db, world.categoryId, {
      name: 'Archived service',
      status: 'disabled',
      archivedAt: new Date(),
    });
    const quotes = await retail.quotes(db, [world.att, world.check, archived, 999999]);
    // An archived service and an unknown id are both absent.
    expect([...quotes.keys()].sort()).toEqual([world.att, world.check].sort());
    expect(quotes.get(world.att)).toMatchObject({ name: 'AT&T USA Premier Unlock' });
    expect(quotes.get(world.att)?.cost.toWire()).toBe('13.5000');
    expect(quotes.get(world.att)?.minProfit.toWire()).toBe('0.8100');
    expect(quotes.get(world.att)?.floor.toWire()).toBe('19.0100');
    expect(quotes.get(world.att)?.retailPrice?.toWire()).toBe('25.9900');
    expect(quotes.get(world.check)?.retailPrice).toBeNull();
    expect(await retail.quotes(db, [])).toEqual(new Map());
  });

  it('sets the retail price, returning the one it replaced, and locks only live services', async () => {
    const { db } = await testDb();
    const retail = t.app.get(RetailPrices);
    const world = await listingWorld(db);
    expect(await retail.retailGroupId(db)).toBe(world.groups.retail);
    await db.transaction(async (tx) => {
      expect(await retail.set(tx, world.att, Money.of('25.9900'))).toBeNull();
      expect((await retail.set(tx, world.att, Money.of('26.5000')))?.toWire()).toBe('25.9900');
      expect((await retail.lockLiveService(tx, world.att, 'share'))?.name).toBe('AT&T USA Premier Unlock');
      expect(await retail.lockLiveService(tx, 999999)).toBeUndefined();
    });
    expect((await retail.quotes(db, [world.att])).get(world.att)?.retailPrice?.toWire()).toBe('26.5000');
  });
});
