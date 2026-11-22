// Integration tests of user rule 2 when a group move and a credit-limit raise of one merchant are sent at the same moment: the two
// requests wait for each other, so the merchant never ends in a group without credit while holding a credit limit, and exactly one of the
// two is refused with `422`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertWalletMerchant } from '../../support/money';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
});

/** A merchant in a group with credit, and a group without credit to move it to. */
async function merchantAndStrictGroup(round: number) {
  const { db } = await testDb();
  const merchant = await insertWalletMerchant(db, { name: `Merchant ${round}`, overdraftAllowed: true });
  const [strict] = await db
    .insert(s.clientGroups)
    .values({ name: `No credit ${round}`, overdraftAllowed: false })
    .returning({ id: s.clientGroups.id });
  return { merchant, strictId: strict!.id };
}

async function stateOf(clientId: number) {
  const { db } = await testDb();
  const [client] = await db.select({ groupId: s.clients.groupId }).from(s.clients).where(eq(s.clients.id, clientId));
  const [wallet] = await db
    .select({ limit: s.ledgerAccounts.overdraftLimit })
    .from(s.ledgerAccounts)
    .where(
      and(
        eq(s.ledgerAccounts.ownerType, 'client'),
        eq(s.ledgerAccounts.ownerId, clientId),
        eq(s.ledgerAccounts.kind, 'client_wallet'),
      ),
    );
  return { groupId: client!.groupId, limit: wallet!.limit };
}

describe('a group move and a credit-limit raise of one merchant (user rule 2)', () => {
  it('refuses the second of the two when they come one after the other, in either order', async () => {
    const mover = await adminWith(t, ['clients:update', 'groups:update', 'clients:read']);
    const setter = await adminWith(t, ['wallet:credit_limit']);
    const first = await merchantAndStrictGroup(1);
    expect(
      (await setter.patch(`/admin/clients/${first.merchant.id}/credit-limit`, { creditLimit: '500.0000' })).status,
    ).toBe(200);
    const move = await mover.patch(`/admin/clients/${first.merchant.id}`, { groupId: first.strictId });
    expect(move.status).toBe(422);
    expect(move.body.errors[0].field).toBe('groupId');
    const second = await merchantAndStrictGroup(2);
    expect((await mover.patch(`/admin/clients/${second.merchant.id}`, { groupId: second.strictId })).status).toBe(200);
    const raise = await setter.patch(`/admin/clients/${second.merchant.id}/credit-limit`, { creditLimit: '500.0000' });
    expect(raise.status).toBe(422);
    expect(raise.body.errors[0].field).toBe('creditLimit');
  });

  it('waits for a change that holds the merchant row (a group move, the nightly promotion) and then judges the new group', async () => {
    const { pool } = await testDb();
    const { merchant, strictId } = await merchantAndStrictGroup(1);
    const setter = await adminWith(t, ['wallet:credit_limit']);
    const other = await pool.connect();
    try {
      // What a group move and the promotion job do: lock the merchant row, then write its new group.
      await other.query('begin');
      await other.query('select id from clients where id = $1 for update', [merchant.id]);
      await other.query('update clients set group_id = $1 where id = $2', [strictId, merchant.id]);
      let answered = false;
      const raise = setter
        .patch(`/admin/clients/${merchant.id}/credit-limit`, { creditLimit: '500.0000' })
        .then((res) => {
          answered = true;
          return res;
        });
      await Bun.sleep(300);
      expect(answered).toBe(false);
      await other.query('commit');
      const res = await raise;
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('creditLimit');
      expect(await stateOf(merchant.id)).toEqual({ groupId: strictId, limit: '0.0000' });
    } finally {
      other.release();
    }
  });

  it('lets exactly one of the two through when they come at the same moment', async () => {
    const mover = await adminWith(t, ['clients:update', 'groups:update', 'clients:read']);
    const setter = await adminWith(t, ['wallet:credit_limit']);
    const outcomes: string[] = [];
    for (let round = 0; round < 25; round++) {
      const { merchant, strictId } = await merchantAndStrictGroup(round);
      const [move, raise] = await Promise.all([
        mover.patch(`/admin/clients/${merchant.id}`, { groupId: strictId }),
        setter.patch(`/admin/clients/${merchant.id}/credit-limit`, { creditLimit: '500.0000' }),
      ]);
      const state = await stateOf(merchant.id);
      const statuses = [move.status, raise.status].sort().join(' ');
      outcomes.push(statuses);
      expect(statuses, `round ${round}`).toBe('200 422');
      // Whichever came second was refused: a merchant in the group without credit holds no limit.
      if (state.groupId === strictId) expect(state.limit, `round ${round}`).toBe('0.0000');
      else expect(state.limit, `round ${round}`).toBe('500.0000');
    }
    expect(outcomes).toHaveLength(25);
  });
});
