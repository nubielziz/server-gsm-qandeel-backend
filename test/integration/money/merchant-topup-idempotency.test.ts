// Integration tests of the merchant top-up create with an optional `Idempotency-Key` (decision 064): a retry with the same request answers the
// same invoice, another request under the key is refused, a create without the header behaves as before, and the create takes the
// account row and then the account's top-up lock, so a rank change and a create serialise: the one that comes second sees the other.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { lockAccountTopUps } from '@src/modules/money';
import { TOPUP_OPENING_GRACE_MS, topUpFingerprint } from '@src/modules/money/domain/invoice-rules';
import { Money } from '@src/common/money';
import { ensureRetailGroup } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, openSession } from '../../support/auth';
import { FakeGateway, GatewayTestModule, insertGateway, insertInvoiceRow } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { PORTAL_ORIGIN } from '../../support/merchant-portal';
import { insertWalletMerchant } from '../../support/money';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
const fake = new FakeGateway();
let t: TestApp;
let db: Database;
/** A transaction of the test pool. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule] });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
});

/** A merchant with a signed-in session and a billing country. */
async function merchant() {
  const made = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
  await db.update(s.clients).set({ country: 'JO' }).where(eq(s.clients.id, made.id));
  return { ...made, session: await openSession(t, { type: 'account', id: made.id }) };
}

/** `POST /client/invoices` as the merchant, with the header only when a key is given. */
const ask = (who: Awaited<ReturnType<typeof merchant>>, body: unknown, key?: string) =>
  t.app.inject({
    method: 'POST',
    url: '/client/invoices',
    headers: {
      ...who.session.mutationHeaders,
      origin: PORTAL_ORIGIN,
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    remoteAddress: '127.0.0.1',
    payload: body as never,
  });

const bank = () =>
  insertGateway(t, db, { code: 'bank', name: 'Bank transfer', isManual: true, minAmount: '50', maxAmount: '5000' });
const card = () =>
  insertGateway(t, db, { code: 'card', name: 'Card gateway', driver: 'card', apiBase: fake.url, audience: 'both' });

describe('POST /client/invoices with an Idempotency-Key', () => {
  it('answers the same invoice to a retry, marks the replay, and stores the key with the request', async () => {
    const who = await merchant();
    const gatewayId = await bank();
    const first = await ask(who, { amount: '100', gatewayId }, 'attempt-1');
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    const again = await ask(who, { amount: '100.00', gatewayId }, 'attempt-1');
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.json().invoice.id).toBe(first.json().invoice.id);
    expect(again.json().instructions).toBe(first.json().instructions);
    const rows = await db.select().from(s.invoices);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      accountId: who.id,
      walletKind: 'client_wallet',
      legacyClientId: who.id,
      idempotencyKey: 'attempt-1',
      requestFingerprint: topUpFingerprint(gatewayId, Money.of('100')),
    });
  });

  it('refuses the same key with another amount or another method', async () => {
    const who = await merchant();
    const gatewayId = await bank();
    const other = await insertGateway(t, db, { code: 'bank-2', name: 'Second bank', isManual: true, minAmount: '50' });
    expect((await ask(who, { amount: '100', gatewayId }, 'attempt-1')).statusCode).toBe(201);
    for (const body of [
      { amount: '120', gatewayId },
      { amount: '100', gatewayId: other },
    ]) {
      const res = await ask(who, body, 'attempt-1');
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    }
    expect(await db.select().from(s.invoices)).toHaveLength(1);
  });

  it('does not share a key between two accounts', async () => {
    const first = await merchant();
    const second = await merchant();
    const gatewayId = await bank();
    const a = await ask(first, { amount: '100', gatewayId }, 'same-key');
    const b = await ask(second, { amount: '100', gatewayId }, 'same-key');
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(b.headers['idempotency-replayed']).toBeUndefined();
    expect(a.json().invoice.id).not.toBe(b.json().invoice.id);
  });

  it('answers a replay even when the account already holds five live unpaid top-ups', async () => {
    const who = await merchant();
    const gatewayId = await bank();
    const answers = [];
    for (let i = 0; i < 5; i += 1) answers.push(await ask(who, { amount: '100', gatewayId }, `attempt-${i}`));
    expect(answers.map((res) => res.statusCode)).toEqual([201, 201, 201, 201, 201]);
    const replay = await ask(who, { amount: '100', gatewayId }, 'attempt-2');
    expect(replay.statusCode).toBe(201);
    expect(replay.json().invoice.id).toBe(answers[2]!.json().invoice.id);
    // A new key is a new request: the sixth is refused as before.
    expect((await ask(who, { amount: '100', gatewayId }, 'attempt-new')).statusCode).toBe(409);
  });

  it('frees the key when the gateway fails, so the same key can try again', async () => {
    const who = await merchant();
    const gatewayId = await card();
    fake.failWith = 500;
    const failed = await ask(who, { amount: '100', gatewayId }, 'card-1');
    expect(failed.statusCode).toBe(502);
    const [voided] = await db.select().from(s.invoices);
    expect(voided).toMatchObject({ status: 'void', idempotencyKey: null });
    fake.failWith = undefined;
    const retry = await ask(who, { amount: '100', gatewayId }, 'card-1');
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotency-replayed']).toBeUndefined();
    expect(retry.json().paymentUrl).toMatch(/^https:\/\/pay\.example\/cs_/);
    // And now the key names the invoice with its page: another retry replays it, with the same address.
    const replay = await ask(who, { amount: '100', gatewayId }, 'card-1');
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json().paymentUrl).toBe(retry.json().paymentUrl);
  });

  it('holds a retry while its page is still opening, and takes the attempt over after a minute', async () => {
    const who = await merchant();
    const gatewayId = await card();
    // The earlier attempt reserved the invoice and never stored its page (the process died after the commit).
    const stale = await insertInvoiceRow(db, who.id, {
      gatewayId,
      idempotencyKey: 'card-1',
      requestFingerprint: topUpFingerprint(gatewayId, Money.of('100')),
      checkoutUrl: null,
      createdAt: clock.now(),
    });
    const busy = await ask(who, { amount: '100', gatewayId }, 'card-1');
    expect(busy.statusCode).toBe(409);
    expect(busy.json().code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(fake.requests).toHaveLength(0);

    clock.advance(TOPUP_OPENING_GRACE_MS + 1000);
    const taken = await ask(who, { amount: '100', gatewayId }, 'card-1');
    expect(taken.statusCode).toBe(201);
    expect(taken.json().invoice.id).not.toBe(stale.id);
    const [old] = await db.select().from(s.invoices).where(eq(s.invoices.id, stale.id));
    expect(old).toMatchObject({ status: 'void', idempotencyKey: null });
  });
});

describe('POST /client/invoices without an Idempotency-Key', () => {
  it('behaves as it always did: every request opens an invoice and none stores a key', async () => {
    const who = await merchant();
    const gatewayId = await bank();
    const a = await ask(who, { amount: '100', gatewayId });
    const b = await ask(who, { amount: '100', gatewayId });
    expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
    expect(a.json().invoice.id).not.toBe(b.json().invoice.id);
    expect((await db.select().from(s.invoices)).map((row) => row.idempotencyKey)).toEqual([null, null]);
  });

  it('refuses a key that is not one printable word', async () => {
    const who = await merchant();
    const gatewayId = await bank();
    for (const key of ['has space', 'a'.repeat(101)]) {
      expect((await ask(who, { amount: '100', gatewayId }, key)).statusCode, key).toBe(422);
    }
    expect(await db.select().from(s.invoices)).toHaveLength(0);
  });
});

describe('the account row and the top-up lock of a create (decision 064)', () => {
  /** Holds a lock in another connection until `release()` and resolves `taken` once it is held. */
  function holdLock(take: (tx: Tx) => Promise<void>, after?: (tx: Tx) => Promise<void>) {
    let release!: () => void;
    let signalTaken!: () => void;
    const taken = new Promise<void>((resolve) => (signalTaken = resolve));
    const done = db.transaction(async (tx) => {
      await take(tx);
      signalTaken();
      await new Promise<void>((resolve) => (release = resolve));
      await after?.(tx);
    });
    return { taken, release: () => release(), done };
  }

  /** Starts a create, reports whether it answered within `ms`, and gives back its promise. */
  async function startCreate(who: Awaited<ReturnType<typeof merchant>>, gatewayId: number, ms = 400) {
    let answered = false;
    const answer = ask(who, { amount: '100', gatewayId }, `k-${crypto.randomUUID()}`).then((res) => {
      answered = true;
      return res;
    });
    await Bun.sleep(ms);
    return { waiting: !answered, answer };
  }

  it('waits for the account top-up lock, the one lock the rank change takes too', async () => {
    const who = await merchant();
    const gatewayId = await bank();
    const held = holdLock((tx) => lockAccountTopUps(tx, who.id));
    await held.taken;
    const create = await startCreate(who, gatewayId);
    expect(create.waiting).toBe(true);
    held.release();
    await held.done;
    expect((await create.answer).statusCode).toBe(201);
  });

  it('waits for the account row, then sees the rank that is live after it: a merchant turned retail is refused', async () => {
    const who = await merchant();
    const gatewayId = await bank();
    const retail = await ensureRetailGroup(db);
    // A rank change holds the account row FOR UPDATE and commits the new rank.
    const held = holdLock(
      async (tx) => void (await tx.execute(sql`select id from clients where id = ${who.id} for update`)),
      async (tx) => void (await tx.update(s.clients).set({ groupId: retail }).where(eq(s.clients.id, who.id))),
    );
    await held.taken;
    const create = await startCreate(who, gatewayId);
    expect(create.waiting).toBe(true);
    held.release();
    await held.done;
    const answer = await create.answer;
    expect(answer.statusCode).toBe(403);
    expect(answer.json().code).toBe('RANK_NOT_ALLOWED');
    expect(await db.select().from(s.invoices)).toHaveLength(0);
  });
});
