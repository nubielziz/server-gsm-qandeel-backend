// Integration test of the customers module's public directory (feature 17 asks it for the guest customer of a new ticket address): it finds
// the customer of an email in any case, makes a guest with the injected clock's time, and ends with one customer when two requests race.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { schema as s } from '../../src/infra/db';
import { CustomerDirectory } from '../../src/modules/customers';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';

const NOW = '2026-11-08T12:00:00.000Z';
const clock = new TestClock(NOW);
const directory = new CustomerDirectory(clock);

beforeEach(async () => {
  clock.set(NOW);
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

describe('CustomerDirectory.findOrCreateGuest', () => {
  it('makes an active guest with no account for a new address, stamped with the injected clock', async () => {
    const { db } = await testDb();
    const guest = await db.transaction((tx) =>
      directory.findOrCreateGuest(tx, { email: 'new@mail.example', name: 'Newcomer' }),
    );
    expect(guest).toMatchObject({ email: 'new@mail.example', name: 'Newcomer', status: 'active' });
    const [row] = await db.select().from(s.customers);
    expect(row).toMatchObject({ id: guest.id, hasAccount: false, status: 'active' });
    expect(row!.createdAt.toISOString()).toBe(NOW);
    expect(row!.updatedAt.toISOString()).toBe(NOW);
  });

  it('returns the customer of a known address in any case and never renames or duplicates them', async () => {
    const { db } = await testDb();
    const [known] = await db
      .insert(s.customers)
      .values({ email: 'Victor@Mail.Example', name: 'Victor Hale' })
      .returning();
    const found = await db.transaction((tx) =>
      directory.findOrCreateGuest(tx, { email: 'victor@mail.example', name: 'Someone else' }),
    );
    expect(found).toMatchObject({ id: known!.id, name: 'Victor Hale' });
    expect(await db.select().from(s.customers)).toHaveLength(1);
  });

  it('ends with one customer when two requests for a new address race to the unique index', async () => {
    const { db } = await testDb();
    const guests = await Promise.all(
      [1, 2, 3].map(() =>
        db.transaction((tx) => directory.findOrCreateGuest(tx, { email: 'race@mail.example', name: '' })),
      ),
    );
    expect(new Set(guests.map((guest) => guest.id)).size).toBe(1);
    expect(await db.select().from(s.customers)).toHaveLength(1);
  });

  it('keeps an anonymized customer as found, with their status, so the caller can refuse to write to them', async () => {
    const { db } = await testDb();
    await db.insert(s.customers).values({ email: 'gone@mail.example', name: 'Deleted customer', status: 'anonymized' });
    const found = await db.transaction((tx) =>
      directory.findOrCreateGuest(tx, { email: 'gone@mail.example', name: 'X' }),
    );
    expect(found.status).toBe('anonymized');
    expect(await db.select().from(s.customers)).toHaveLength(1);
  });
});
