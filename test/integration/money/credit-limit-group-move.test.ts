// Integration tests of user rule 2 when a rank change and a credit-limit raise of one merchant account are sent at the same moment: the two
// requests wait for each other, so the account never ends in a rank without credit while holding a credit limit, and exactly one of the
// two is refused (`409 RANK_CHANGE_BLOCKED` for the rank change, `422` for the raise). A rank is changed only by `POST /admin/clients/:id/rank`
// (decision 064); `PATCH /admin/clients/:id` takes no group any more.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
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

/** An Idempotency-Key header: the rank route and the credit-limit route both require one (decision 064). */
const newKey = () => ({ 'idempotency-key': crypto.randomUUID() });

/** A merchant in a group with credit, and a group without credit to move it to. */
async function merchantAndStrictGroup(round: number) {
  const { db } = await testDb();
  const merchant = await insertWalletMerchant(db, { name: `Merchant ${round}`, overdraftAllowed: true });
  const [strict] = await db
    .insert(s.clientGroups)
    .values({ name: `No credit ${round}`, kind: 'b2b', overdraftAllowed: false })
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
        eq(s.ledgerAccounts.ownerType, 'account'),
        eq(s.ledgerAccounts.ownerId, clientId),
        eq(s.ledgerAccounts.kind, 'client_wallet'),
      ),
    );
  return { groupId: client!.groupId, limit: wallet!.limit };
}

describe('a rank change and a credit-limit raise of one merchant account (user rule 2)', () => {
  /** The rank route: the Owner role itself, a body with the group only, a key. */
  const moveTo = (owner: AdminApi, clientId: number, groupId: number) =>
    owner.post(`/admin/clients/${clientId}/rank`, { groupId }, newKey());
  const raiseTo = (setter: AdminApi, clientId: number) =>
    setter.call('PATCH', `/admin/clients/${clientId}/credit-limit`, { creditLimit: '500.0000' }, newKey());

  it('refuses the second of the two when they come one after the other, in either order', async () => {
    const owner = await adminWith(t, ['*']);
    const setter = await adminWith(t, ['wallet:credit_limit']);
    const first = await merchantAndStrictGroup(1);
    expect((await raiseTo(setter, first.merchant.id)).status).toBe(200);
    const move = await moveTo(owner, first.merchant.id, first.strictId);
    expect(move.status).toBe(409);
    expect(move.body.code).toBe('RANK_CHANGE_BLOCKED');
    expect(move.body.errors[0]).toMatchObject({ field: 'groupId', code: 'credit_limit' });
    const second = await merchantAndStrictGroup(2);
    expect((await moveTo(owner, second.merchant.id, second.strictId)).status).toBe(200);
    const raise = await raiseTo(setter, second.merchant.id);
    expect(raise.status).toBe(422);
    expect(raise.body.errors[0].field).toBe('creditLimit');
  });

  it('no longer changes a group through the account update: a group in the body is 422', async () => {
    const editor = await adminWith(t, ['clients:update', 'clients:read']);
    const { merchant, strictId } = await merchantAndStrictGroup(1);
    const res = await editor.patch(`/admin/clients/${merchant.id}`, { groupId: strictId });
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'groupId', code: 'use_rank_route' });
  });

  it('waits for a change that holds the account row (a rank change) and then judges the new rank', async () => {
    const { pool } = await testDb();
    const { merchant, strictId } = await merchantAndStrictGroup(1);
    const setter = await adminWith(t, ['wallet:credit_limit']);
    const other = await pool.connect();
    try {
      // What a group move does: lock the merchant row, then write its new group.
      await other.query('begin');
      await other.query('select id from clients where id = $1 for update', [merchant.id]);
      await other.query('update clients set group_id = $1 where id = $2', [strictId, merchant.id]);
      let answered = false;
      const raise = raiseTo(setter, merchant.id).then((res) => {
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
    const owner = await adminWith(t, ['*']);
    const setter = await adminWith(t, ['wallet:credit_limit']);
    const outcomes: string[] = [];
    for (let round = 0; round < 25; round++) {
      const { merchant, strictId } = await merchantAndStrictGroup(round);
      const [move, raise] = await Promise.all([moveTo(owner, merchant.id, strictId), raiseTo(setter, merchant.id)]);
      const state = await stateOf(merchant.id);
      // The rank change wins (200) and the raise is refused (422), or the raise wins (200) and the rank change is refused (409).
      const statuses = `${move.status} ${raise.status}`;
      outcomes.push(statuses);
      expect(['200 422', '409 200'], `round ${round}`).toContain(statuses);
      // Whichever came second was refused: a merchant in the group without credit holds no limit.
      if (state.groupId === strictId) expect(state.limit, `round ${round}`).toBe('0.0000');
      else expect(state.limit, `round ${round}`).toBe('500.0000');
    }
    expect(outcomes).toHaveLength(25);
  });
});
