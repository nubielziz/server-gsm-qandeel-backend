// The billing seed with the demo merchants present: the four demo gateways (credentials only where there is an API), the 54 top-ups
// with an invoice each linked to the deposit journals the money seed replayed, the manual invoices and the verification requests.
// Needs the frontend checkout (the demo state); the merchants are inserted with the demo ids and groups, as money-seed.test does.
import { afterAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { parseEnv } from '../../src/config';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { GATEWAY_CONFIG_AAD } from '../../src/modules/money/application/gateway-credentials';
import { demoNumericId, demoRows, demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { insertRows } from '../../scripts/seed/helpers';
import { runSeed } from '../../scripts/seed/run';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { testInstanceEnv } from '../support/env';

// The demo seed posts about 2,000 journals one transaction each: more than the suite's 15 s on a busy machine.
setDefaultTimeout(60_000);

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

interface DemoMerchant {
  id: string;
  name: string;
  group: 'std' | 'whl' | 'vip';
  email: string;
  cc: string;
  kyc: string;
}

const GROUPS = { std: 1, whl: 2, vip: 3 } as const;

async function insertDemoMerchants(demo: Awaited<ReturnType<typeof loadDemoState>>) {
  const { db } = await testDb();
  const groups = [
    { id: 1, name: 'std', isDefault: true, overdraftAllowed: false },
    { id: 2, name: 'whl', isDefault: false, overdraftAllowed: true },
    { id: 3, name: 'vip', isDefault: false, overdraftAllowed: true },
  ];
  await insertRows(db, s.clientGroups, groups);
  await insertRows(
    db,
    s.clients,
    demoRows<DemoMerchant>(demo, 'merchants').map((merchant) => ({
      id: demoNumericId(merchant.id),
      username: merchant.id,
      email: merchant.email,
      name: merchant.name,
      country: merchant.cc,
      groupId: GROUPS[merchant.group],
      referralCode: `REF-${merchant.id}`,
      status: 'active' as const,
      kycStatus: merchant.kyc === 'Verified' ? ('approved' as const) : ('pending' as const),
    })),
  );
}

describe.skipIf(!existsSync(demoStatePath()))('the billing seed', () => {
  it('seeds the demo gateways, top-ups and invoices, linked to the deposit journals of the money seed', async () => {
    const { db } = await testDb();
    const demo = await loadDemoState();
    await insertDemoMerchants(demo);
    const config = parseEnv({ NODE_ENV: 'test', ...testInstanceEnv() });
    const reports = await runSeed(db, demo, config);
    const demoPayments = demoRows<{ id: string; status: string; gross: number; net: number; method: string }>(
      demo,
      'payments',
    );
    expect(
      reports.filter((report) => report.module === 'billing').map((report) => [report.table, report.inserted]),
    ).toEqual([
      ['payment_gateways', 4],
      ['invoices', demoPayments.length + 3],
      ['payments', demoPayments.length],
      ['kyc_submissions', demoRows(demo, 'merchants').length],
    ]);

    const gateways = await db.select().from(s.paymentGateways).orderBy(s.paymentGateways.id);
    expect(gateways.map((gateway) => [gateway.id, gateway.code, gateway.audience, gateway.isManual])).toEqual([
      [1, 'card', 'b2c', false],
      [2, 'crypto', 'both', false],
      [3, 'bank', 'b2b', true],
      [4, 'wise', 'b2b', true],
    ]);
    expect(gateways[0]).toMatchObject({ feePercent: '2.9000', feeFixed: '0.3000', supports3ds: true });
    const encryption = new EncryptionService(config);
    expect(JSON.parse(encryption.decrypt(gateways[0]!.configEnc!, GATEWAY_CONFIG_AAD)).secret).toMatch(
      /^sk_seed_card_/,
    );
    expect(gateways[2]!.configEnc).toBeNull();

    // Every payment has the invoice with its number minus 999, in the status its own implies.
    const payments = (await db.select().from(s.payments).orderBy(s.payments.id)).filter(
      (payment) => payment.purpose === 'topup',
    );
    const invoices = new Map((await db.select().from(s.invoices)).map((invoice) => [invoice.id, invoice]));
    expect(payments).toHaveLength(demoPayments.length);
    const byStatus = (status: string) => payments.filter((payment) => payment.status === status).length;
    expect([byStatus('approved'), byStatus('rejected'), byStatus('pending')]).toEqual([46, 2, 6]);
    for (const payment of payments) {
      const invoice = invoices.get(payment.invoiceId!)!;
      expect(invoice.id).toBe(payment.id - 999);
      const expected: Record<string, string> = { approved: 'paid', rejected: 'void', pending: 'open' };
      expect<string>(invoice.status).toBe(expected[payment.status]!);
      expect(invoice.number).toMatch(/^INV-\d{4}-\d{4}$/);
      expect(invoice.taxCountry).not.toBe('');
    }
    // Pending payments of an automatic gateway wait for staff; those of a manual gateway always did.
    const pending = payments.filter((payment) => payment.status === 'pending');
    expect(pending.filter((payment) => payment.reviewRequired).map((payment) => payment.gatewayId)).toEqual([2, 2]);

    // Each approved payment is the reference of exactly one deposit journal, for its net, funded from where its gateway says.
    const lines = await db
      .select({ refId: s.ledgerTransactions.refId, kind: s.ledgerAccounts.kind, amount: s.ledgerEntries.amount })
      .from(s.ledgerTransactions)
      .innerJoin(s.ledgerEntries, eq(s.ledgerEntries.transactionId, s.ledgerTransactions.id))
      .innerJoin(s.ledgerAccounts, eq(s.ledgerAccounts.id, s.ledgerEntries.accountId))
      .where(and(eq(s.ledgerTransactions.refType, 'payment'), eq(s.ledgerTransactions.kind, 'deposit')));
    const walletCredit = new Map(
      lines.filter((line) => line.kind === 'client_wallet').map((line) => [line.refId, Number(line.amount)]),
    );
    const approved = payments.filter((payment) => payment.status === 'approved');
    expect(walletCredit.size).toBe(approved.length);
    for (const payment of approved) {
      expect(walletCredit.get(payment.id)).toBeCloseTo(-(Number(payment.amount) - Number(payment.feeAmount)), 2);
      const source = lines.find(
        (line) => line.refId === payment.id && (line.kind === 'bank' || line.kind === 'gateway_clearing'),
      )!;
      expect(source.kind).toBe(payment.gatewayId === 3 || payment.gatewayId === 4 ? 'bank' : 'gateway_clearing');
    }

    // The manual invoices and one verification request per merchant, in step with `clients.kyc_status`.
    expect(
      [...invoices.values()]
        .filter((invoice) => invoice.kind === 'manual')
        .map((invoice) => invoice.status)
        .sort(),
    ).toEqual(['open', 'open', 'void']);
    const kyc = await db
      .select({ status: s.kycSubmissions.status, client: s.kycSubmissions.clientId })
      .from(s.kycSubmissions);
    const clients = new Map((await db.select().from(s.clients)).map((client) => [client.id, client.kycStatus]));
    expect(kyc.every((row) => clients.get(row.client) === row.status)).toBe(true);
    const [dup] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.kycSubmissions)
      .where(eq(s.kycSubmissions.status, 'pending'));
    expect(dup!.n).toBeGreaterThan(0);
  });

  it('is idempotent: a second run inserts nothing', async () => {
    const { db } = await testDb();
    const demo = await loadDemoState();
    await insertDemoMerchants(demo);
    await runSeed(db, demo);
    const second = await runSeed(db, await loadDemoState({ now: Date.parse('2026-11-02T10:00:00.000Z') }));
    expect(second.filter((report) => report.module === 'billing').map((report) => report.inserted)).toEqual([
      0, 0, 0, 0,
    ]);
  });
});
