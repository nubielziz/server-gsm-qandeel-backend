// Integration tests of the rank change against the paths that move money or freeze a wallet of the same account (decision 064): a top-up
// create, a portal placement, a staff adjustment, a staff freeze, a payment crediting and a dispute posting. Each of these takes the account
// row `FOR KEY SHARE` before it reads the rank kind, so a rank change (`FOR UPDATE`) either waits and then sees what the path committed, or goes
// first and the path then sees the new rank: no money ever lands on (and no freeze ever hits) the wallet that is not live, and nothing waits for
// ever. The first group holds the lock the way those paths do and commits their effect; the second group sends real requests at the same moment.
// The third group holds the account row the way a rank change or an erasure does while a receipt upload runs: the upload takes the row before
// the top-up lock and the invoice row, so it never holds what they wait for.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Money } from '@src/common/money';
import { AppError } from '@src/common/errors';
import { type Database, type Transaction, schema as s } from '@src/infra/db';
import { MerchantAccounts, deposit, lockAccountTopUps, order as orderEvent, postTransaction } from '@src/modules/money';
import { CustomerTopUps } from '@src/modules/money/application/customer-top-ups';
import { MerchantBillingService } from '@src/modules/money/application/merchant-billing.service';
import { type AdminApi, type ApiAnswer, adminWith } from '../../support/admin-api';
import { accountRow, ensureRetailGroup, makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertGateway, insertInvoiceRow, insertProofFile } from '../../support/billing';
import { fundCustomer } from '../../support/customer-wallet';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { fundWallet, ledgerTotals } from '../../support/money';

const clock = new TestClock('2026-11-10T12:00:00.000Z');
let t: TestApp;
let db: Database;
let owner: AdminApi;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-10T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await insertUsd(db);
  owner = await adminWith(t, ['*'], { name: 'Owner One' });
});

/** The retail rank and two merchant ranks (the first allows credit). */
async function ranks() {
  const retailId = await ensureRetailGroup(db);
  const [gold] = await db
    .insert(s.clientGroups)
    .values({ name: 'Gold', kind: 'b2b', overdraftAllowed: true })
    .returning({ id: s.clientGroups.id });
  const [basic] = await db
    .insert(s.clientGroups)
    .values({ name: 'Basic', kind: 'b2b' })
    .returning({ id: s.clientGroups.id });
  return { retailId, goldId: gold!.id, basicId: basic!.id };
}

/** A merchant of a rank with its wallet and hold opened and a balance. */
async function merchantOf(groupId: number, balance: string) {
  const account = await makeAccount({ rank: 'merchant', groupId });
  await new MerchantAccounts().open(db, {
    clientId: account.id,
    currency: 'USD',
    // The opener takes the wire form of an amount (four decimals).
    creditLimit: '0.0000',
    overdraftAllowed: true,
  });
  // A zero balance posts nothing (a journal needs two lines).
  if (Money.of(balance).isPositive()) await fundWallet(db, account.id, balance);
  return account;
}

function change(accountId: number, groupId: number, key = `k-${crypto.randomUUID()}`): Promise<ApiAnswer> {
  return owner.post(`/admin/clients/${accountId}/rank`, { groupId }, { 'idempotency-key': key });
}

async function walletsOf(accountId: number) {
  const rows = await db
    .select()
    .from(s.ledgerAccounts)
    .where(and(eq(s.ledgerAccounts.ownerType, 'account'), eq(s.ledgerAccounts.ownerId, accountId)));
  return new Map(rows.map((row) => [row.kind, row]));
}

function transfersOf(accountId: number) {
  return db
    .select()
    .from(s.ledgerTransactions)
    .where(and(eq(s.ledgerTransactions.kind, 'wallet_transfer'), eq(s.ledgerTransactions.refId, accountId)))
    .orderBy(asc(s.ledgerTransactions.id));
}

/** Posts a deposit to a merchant wallet inside the given transaction, as a crediting or an adjustment does. */
function creditIn(tx: Transaction, accountId: number, amount: string) {
  return postTransaction(
    tx,
    {
      ...deposit({ clientId: accountId, amount: Money.of(amount) }),
      refId: accountId,
      idempotencyKey: `race:credit:${accountId}:${crypto.randomUUID()}`,
      currency: 'USD',
      createdBy: { type: 'system', id: null },
    },
    clock.now(),
  );
}

/**
 * Holds the account row `FOR KEY SHARE` like a money path does, starts the rank change while it is held, checks the change waits, lets the
 * path commit its effect, and answers what the change answered.
 */
async function whileHolding(
  accountId: number,
  start: () => Promise<ApiAnswer>,
  effect: (tx: Transaction) => Promise<void>,
): Promise<ApiAnswer> {
  let locked!: () => void;
  const hasLock = new Promise<void>((resolve) => (locked = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const holder = db.transaction(async (tx) => {
    await tx.execute(sql`select id from clients where id = ${accountId} for key share`);
    locked();
    await gate;
    await effect(tx);
  });
  await hasLock;
  let answered = false;
  const pending = start().then((res) => {
    answered = true;
    return res;
  });
  try {
    await Bun.sleep(300);
    expect(answered).toBe(false);
  } finally {
    release();
  }
  await holder;
  return pending;
}

const codesOf = (res: ApiAnswer): string[] => (res.body.errors as Array<{ code: string }>).map((entry) => entry.code);

describe('a rank change that meets a path holding the account row', () => {
  it('a top-up create: the change waits, then refuses because the top-up is open, and the wallet stays where it was', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, '20');
    const res = await whileHolding(
      account.id,
      () => change(account.id, retailId),
      async (tx) => {
        await lockAccountTopUps(tx, account.id);
        await tx.insert(s.invoices).values({
          number: `INV-RACE-${account.id}`,
          accountId: account.id,
          legacyClientId: account.id,
          kind: 'topup',
          walletKind: 'client_wallet',
          amount: '10.0000',
          netAmount: '10.0000',
          total: '10.0000',
          currency: 'USD',
          status: 'open',
          taxCountry: 'JO',
          createdAt: clock.now(),
        });
      },
    );
    expect(res.status).toBe(409);
    expect(codesOf(res)).toEqual(['open_topup']);
    expect((await accountRow(account.id)).groupId).toBe(goldId);
    expect((await walletsOf(account.id)).get('client_wallet')!.balance).toBe('20.0000');
  });

  it('a portal placement: the change waits, then refuses because the hold is open', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, '20');
    const res = await whileHolding(
      account.id,
      () => change(account.id, retailId),
      async (tx) => {
        await postTransaction(
          tx,
          {
            ...orderEvent({ clientId: account.id, amount: Money.of('6') }),
            refId: account.id,
            idempotencyKey: `race:hold:${account.id}`,
            currency: 'USD',
            createdBy: { type: 'system', id: null },
          },
          clock.now(),
        );
      },
    );
    expect(res.status).toBe(409);
    expect(codesOf(res)).toEqual(['open_hold']);
    const wallets = await walletsOf(account.id);
    expect(wallets.get('client_wallet')!.balance).toBe('14.0000');
    expect(wallets.get('client_hold')!.balance).toBe('6.0000');
    expect(wallets.has('customer_wallet')).toBe(false);
  });

  it('a staff adjustment: the change waits, then moves the balance with the adjustment, and nothing stays on the merchant wallet', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, '20');
    const res = await whileHolding(
      account.id,
      () => change(account.id, retailId),
      async (tx) => {
        await creditIn(tx, account.id, '5');
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.movedAmount).toBe('25.0000');
    const wallets = await walletsOf(account.id);
    expect(wallets.get('client_wallet')!.balance).toBe('0.0000');
    expect(wallets.get('customer_wallet')!.balance).toBe('25.0000');
  });

  it('a payment crediting: the change waits, then moves what was credited', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, '0');
    const invoice = await insertInvoiceRow(db, account.id, { kind: 'topup', status: 'open', createdAt: clock.now() });
    const res = await whileHolding(
      account.id,
      () => change(account.id, retailId),
      async (tx) => {
        await creditIn(tx, account.id, '12');
        await tx.update(s.invoices).set({ status: 'paid', paidAt: clock.now() }).where(eq(s.invoices.id, invoice.id));
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.movedAmount).toBe('12.0000');
    expect((await walletsOf(account.id)).get('client_wallet')!.balance).toBe('0.0000');
  });

  it('a staff freeze: the change waits, then refuses because the wallet is on hold, and the retail wallet is not frozen', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, '20');
    const res = await whileHolding(
      account.id,
      () => change(account.id, retailId),
      async (tx) => {
        await tx
          .update(s.ledgerAccounts)
          .set({ frozenAt: clock.now(), frozenReason: 'Review' })
          .where(and(eq(s.ledgerAccounts.ownerId, account.id), eq(s.ledgerAccounts.kind, 'client_wallet')));
      },
    );
    expect(res.status).toBe(409);
    expect(codesOf(res)).toEqual(['frozen']);
    const wallets = await walletsOf(account.id);
    expect(wallets.get('client_wallet')!.frozenAt).not.toBeNull();
    expect(wallets.get('customer_wallet')?.frozenAt ?? null).toBeNull();
  });

  it('a dispute posting: the change waits, then refuses for the open dispute and the freeze it caused', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, '20');
    const gatewayId = await insertGateway(t, db);
    const invoice = await insertInvoiceRow(db, account.id, { kind: 'topup', status: 'paid' });
    const [payment] = await db
      .insert(s.payments)
      .values({
        accountId: account.id,
        invoiceId: invoice.id,
        purpose: 'topup',
        gatewayId,
        amount: '20.0000',
        currency: 'USD',
        status: 'approved',
        methodType: 'card',
      })
      .returning({ id: s.payments.id });
    const res = await whileHolding(
      account.id,
      () => change(account.id, retailId),
      async (tx) => {
        await tx.insert(s.disputes).values({
          paymentId: payment!.id,
          accountId: account.id,
          gatewayDisputeId: 'dp_race_1',
          reasonCode: 'fraudulent',
          amount: '20.0000',
          currency: 'USD',
          status: 'needs_response',
          evidenceDueAt: new Date('2026-11-20T00:00:00.000Z'),
        });
        await tx
          .update(s.ledgerAccounts)
          .set({ frozenAt: clock.now(), frozenReason: 'Dispute dp_race_1' })
          .where(and(eq(s.ledgerAccounts.ownerId, account.id), eq(s.ledgerAccounts.kind, 'client_wallet')));
      },
    );
    expect(res.status).toBe(409);
    expect(codesOf(res)).toEqual(['open_dispute', 'frozen']);
    expect((await accountRow(account.id)).groupId).toBe(goldId);
  });
});

describe('requests sent at the same moment', () => {
  it('a staff adjustment and the rank change: the money ends on the wallet that is live after the change, never on the other', async () => {
    const { retailId, goldId } = await ranks();
    for (let round = 0; round < 8; round++) {
      const account = await merchantOf(goldId, '50');
      const [moved, adjusted] = await Promise.all([
        change(account.id, retailId),
        owner.post(
          `/admin/clients/${account.id}/wallet/adjust`,
          { amount: '5.0000', direction: 'credit', reason: 'Goodwill credit' },
          { 'idempotency-key': `adjust-${round}` },
        ),
      ]);
      expect([moved.status, adjusted.status], `round ${round}`).toEqual([200, 200]);
      const wallets = await walletsOf(account.id);
      expect(wallets.get('client_wallet')!.balance, `round ${round}`).toBe('0.0000');
      expect(wallets.get('customer_wallet')!.balance, `round ${round}`).toBe('55.0000');
    }
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  }, 60_000);

  it('a staff freeze and the rank change: the hold is on the live wallet, or the change was refused for it, never on the other', async () => {
    const { retailId, goldId } = await ranks();
    const outcomes = new Set<string>();
    for (let round = 0; round < 8; round++) {
      const account = await merchantOf(goldId, '30');
      const [moved, frozen] = await Promise.all([
        change(account.id, retailId),
        owner.post(
          `/admin/clients/${account.id}/wallet/freeze`,
          { reason: 'Checking a payment' },
          { 'idempotency-key': `freeze-${round}` },
        ),
      ]);
      const wallets = await walletsOf(account.id);
      if (moved.status === 200) {
        // The change went first: the freeze met the retail rank and hit the store balance; the merchant wallet was never frozen.
        expect(frozen.status, `round ${round}`).toBe(200);
        expect(wallets.get('client_wallet')!.frozenAt, `round ${round}`).toBeNull();
        expect(wallets.get('customer_wallet')!.frozenAt, `round ${round}`).not.toBeNull();
        outcomes.add('change first');
      } else {
        // The freeze went first: the change was refused for it and the merchant wallet is the frozen one.
        expect(moved.status, `round ${round}`).toBe(409);
        expect(codesOf(moved), `round ${round}`).toEqual(['frozen']);
        expect(wallets.get('client_wallet')!.frozenAt, `round ${round}`).not.toBeNull();
        expect((await accountRow(account.id)).groupId, `round ${round}`).toBe(goldId);
        outcomes.add('freeze first');
      }
    }
    expect(outcomes.size).toBeGreaterThan(0);
  }, 60_000);

  it('the same key twice: one change, one replay, one posting', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, '18');
    const [one, two] = await Promise.all([
      change(account.id, retailId, 'twice'),
      change(account.id, retailId, 'twice'),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    const replays = [one, two].filter((res) => res.res.headers['idempotency-replayed'] === 'true');
    expect(replays).toHaveLength(1);
    expect(one.body.transactionId).toBe(two.body.transactionId);
    expect(await transfersOf(account.id)).toHaveLength(1);
    expect((await walletsOf(account.id)).get('customer_wallet')!.balance).toBe('18.0000');
  });

  it('two different keys for the same rank: one change wins and the other is refused as no change, with one posting', async () => {
    const { retailId, goldId } = await ranks();
    const account = await merchantOf(goldId, '18');
    const [one, two] = await Promise.all([
      change(account.id, retailId, 'first'),
      change(account.id, retailId, 'second'),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 422]);
    const refused = one.status === 422 ? one : two;
    expect(refused.body.errors[0]).toMatchObject({ field: 'groupId', code: 'same_rank' });
    expect(await transfersOf(account.id)).toHaveLength(1);
  });

  it('two changes to different ranks: they run one after the other, the balance moves once and the history chains', async () => {
    const { retailId, goldId, basicId } = await ranks();
    const account = await makeAccount({ rank: 'retail', groupId: retailId });
    await fundCustomer(db, account.id, '14');
    const [first, second] = await Promise.all([
      change(account.id, goldId, 'to-gold'),
      change(account.id, basicId, 'to-basic'),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const history = await db
      .select()
      .from(s.accountRankChanges)
      .where(eq(s.accountRankChanges.accountId, account.id))
      .orderBy(asc(s.accountRankChanges.id));
    expect(history).toHaveLength(2);
    expect(history[1]!.fromGroupId).toBe(history[0]!.toGroupId);
    expect(new Set([history[0]!.toGroupId, history[1]!.toGroupId])).toEqual(new Set([goldId, basicId]));
    // The balance crossed once (retail to merchant) and then stayed with the merchant wallet.
    expect(await transfersOf(account.id)).toHaveLength(1);
    expect((await walletsOf(account.id)).get('client_wallet')!.balance).toBe('14.0000');
    expect((await walletsOf(account.id)).get('customer_wallet')!.balance).toBe('0.0000');
  });
});

/** Waits until a transaction of the test database waits for a lock. */
async function untilALockWaits(): Promise<void> {
  for (let round = 0; round < 150; round++) {
    const result = await db.execute<{ n: number }>(sql`select count(*)::int as n from pg_locks where not granted`);
    if ((result.rows[0]?.n ?? 0) > 0) return;
    await Bun.sleep(20);
  }
  throw new Error('No transaction waited for a lock.');
}

/**
 * Holds the account row `FOR UPDATE` as a rank change and an erasure take it first, starts a receipt upload while it is held, waits until the
 * upload waits for a lock, then takes the next lock of that use case and commits. An upload that waits for the account row before it holds
 * anything leaves that lock free, so both end; one that held the top-up lock or the invoice row while it waited for the account row would close
 * a cycle and Postgres would abort one side (40P01).
 *
 * @returns what the holder did (`committed` or its error) and what the upload answered or threw
 */
async function uploadWhileHeld(
  accountId: number,
  upload: () => Promise<unknown>,
  next: (tx: Transaction) => Promise<unknown>,
): Promise<{ held: unknown; answer: unknown; error: unknown }> {
  let locked!: () => void;
  const hasLock = new Promise<void>((resolve) => (locked = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const holder = db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`select id from clients where id = ${accountId} for update`);
    locked();
    await gate;
    await next(tx);
  });
  await hasLock;
  const uploaded = upload().then(
    (answer) => ({ answer, error: undefined }),
    (error: unknown) => ({ answer: undefined, error }),
  );
  try {
    await untilALockWaits();
  } finally {
    release();
  }
  const held = await holder.then(
    () => 'committed',
    (error: unknown) => error,
  );
  return { held, ...(await uploaded) };
}

const paymentsOf = (invoiceId: number) => db.select().from(s.payments).where(eq(s.payments.invoiceId, invoiceId));

describe('a receipt upload while a rank change or an erasure holds the account row', () => {
  /** A manual method open to both wallet kinds. */
  const bank = () =>
    insertGateway(t, db, { code: 'bank', driver: 'manual', name: 'Bank transfer', isManual: true, audience: 'both' });

  /** An open merchant top-up paid by transfer, and the upload of its receipt through the portal's use case. */
  async function merchantUpload() {
    const { goldId } = await ranks();
    const account = await merchantOf(goldId, '0');
    const invoice = await insertInvoiceRow(db, account.id, { gatewayId: await bank() });
    const fileId = await insertProofFile(db, account.id);
    const billing = t.app.get(MerchantBillingService, { strict: false });
    return {
      accountId: account.id,
      invoiceId: invoice.id,
      upload: () => billing.uploadReceipt(account.id, invoice.id, { fileId, reference: 'TRX-7001' }),
    };
  }

  /** An open store top-up paid by transfer, and the upload of its receipt through the shop's use case. */
  async function storeUpload() {
    const account = await makeAccount({ rank: 'retail', groupId: await ensureRetailGroup(db) });
    const invoice = await insertInvoiceRow(db, account.id, {
      walletKind: 'customer_wallet',
      legacyClientId: null,
      amount: '50.0000',
      gatewayId: await bank(),
    });
    const fileId = await insertProofFile(db, account.id);
    const topUps = t.app.get(CustomerTopUps, { strict: false });
    return {
      accountId: account.id,
      invoiceId: invoice.id,
      upload: () => topUps.attachReceipt(account.id, invoice.id, { fileId, reference: 'TRX-7002' }),
    };
  }

  for (const [door, make] of [
    ['portal', merchantUpload],
    ['store', storeUpload],
  ] as const) {
    it(`${door}: against a rank change (then the top-up lock), both end and the receipt waits for review`, async () => {
      const { accountId, invoiceId, upload } = await make();
      const outcome = await uploadWhileHeld(accountId, upload, (tx) => lockAccountTopUps(tx, accountId));
      expect(outcome.held).toBe('committed');
      expect(outcome.error).toBeUndefined();
      expect((await paymentsOf(invoiceId)).map((payment) => payment.status)).toEqual(['pending']);
    });

    it(`${door}: against an erasure (then the open top-up voided), both end and the upload is refused for the closed top-up`, async () => {
      const { accountId, invoiceId, upload } = await make();
      const outcome = await uploadWhileHeld(accountId, upload, (tx) =>
        tx.update(s.invoices).set({ status: 'void' }).where(eq(s.invoices.id, invoiceId)),
      );
      expect(outcome.held).toBe('committed');
      expect(outcome.error).toBeInstanceOf(AppError);
      expect((outcome.error as AppError).code).toBe('CONFLICT');
      expect(await paymentsOf(invoiceId)).toEqual([]);
    });
  }
});
