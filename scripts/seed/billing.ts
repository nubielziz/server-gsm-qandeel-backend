// Seeder of billing (stage 8): the demo's four payment gateways, its 54 wallet top-ups with an invoice each (linked to the deposit
// journals the money seed replayed: `ledger_transactions.ref_type = 'payment'`, `ref_id` = the payment id), three manual invoices,
// and the verification requests of the merchants.
// Mapped as the frontend mocks map them: src/features/settings/mocks/seedPayments.ts (gateways), src/features/finance/mocks/
// paymentStore.ts and invoices.ts, src/features/merchants/mocks/kycSeed.ts.
import type { AppConfig } from '../../src/config';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import {
  GATEWAY_CONFIG_AAD,
  GATEWAY_WEBHOOK_SECRET_AAD,
} from '../../src/modules/money/application/gateway-credentials';
import { topupMethodOf } from '../../src/modules/money/domain/gateway-rules';
import { invoiceNumber } from '../../src/modules/money/domain/invoice-rules';
import { type DemoSeed, demoNumericId, demoRows, toDate, toMoney } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

const DAY_MS = 86_400_000;

/** A gateway of the demo state (`settings.gateways`). */
interface DemoGateway {
  id: string;
  name: string;
  desc: string;
  audience: string;
  methods: string;
  fee: string;
  refunds: boolean;
  threeDS: boolean;
  on: boolean;
  mode: string;
}

/** A payment of the demo state (`payments`). */
interface DemoPayment {
  id: string;
  mid: string;
  method: 'bank' | 'card' | 'usdt' | 'wise';
  gross: number;
  fee: number;
  net: number;
  status: 'pending' | 'approved' | 'rejected';
  created: number;
  reviewedAt: number | null;
  reviewedBy: string | null;
  ref: string;
  note: string;
}

/** A merchant of the demo state (`merchants`). */
interface DemoMerchant {
  id: string;
  name: string;
  cc: string;
  status: string;
  kyc: string;
}

const AUDIENCE: Record<string, 'b2c' | 'b2b' | 'both'> = { B2C: 'b2c', B2B: 'b2b', 'B2C and B2B': 'both' };

// Limits and holds the demo does not have (the console mock invents the same): a card is quick and small, a bank transfer is manual and large.
const LIMITS: Record<string, { min: number; max: number; hold: number; groups: number[] }> = {
  card: { min: 1, max: 2000, hold: 0, groups: [] },
  crypto: { min: 5, max: 10000, hold: 0, groups: [] },
  bank: { min: 50, max: 50000, hold: 24, groups: [2, 3] },
  wise: { min: 50, max: 50000, hold: 24, groups: [] },
};

/** "2.9% + $0.30" is 2.9 percent and 0.30 dollars; "Free" is nothing. */
function parseFee(text: string): { percent: number; fixed: number } {
  const percent = /([\d.]+)\s*%/.exec(text);
  const fixed = /\$([\d.]+)/.exec(text);
  return { percent: percent ? Number(percent[1]) : 0, fixed: fixed ? Number(fixed[1]) : 0 };
}

/**
 * Seeds the gateways, top-ups, invoices and verification requests of the demo.
 *
 * Why: seed = frontend mocks (decision 014): the Deposits, Invoices and Verification tabs and Settings > Payment methods show the demo
 * through the real API. The gateway ids are the demo's (1 to 4) and so are the payment ids (`PAY-1000` is 1000, its invoice is 1). A
 * pending payment of an automatic gateway is sent to staff review (`review_required`), so the console can approve it. Approved payments
 * keep the staff member who approved them; the card and crypto ones the demo shows as `System` have no reviewer, as the real automatic
 * credit leaves them. Development gateways with an API get a fake credential (so the secret hint shows) and a webhook key when the
 * configuration is known. No receipt files or invoice PDFs are seeded (there are no objects to download).
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @param config the application configuration (encryption keys); without it the gateways carry no credentials
 * @returns one report per table
 */
export async function seedBilling(db: DbExecutor, demo: DemoSeed, config?: AppConfig): Promise<SeedReport[]> {
  const encryption = config ? new EncryptionService(config) : undefined;
  const gateways = gatewayRowsOf(
    (demo.state.settings as { gateways?: DemoGateway[] } | undefined)?.gateways ?? [],
    encryption,
    demo.now,
  );
  const gatewayReport = await insertRows(db, s.paymentGateways, gateways);

  const merchants = new Map(demoRows<DemoMerchant>(demo, 'merchants').map((merchant) => [merchant.id, merchant]));
  const present = new Set((await db.select({ id: s.clients.id }).from(s.clients)).map((row) => row.id));
  const staffIds = new Map(
    demoRows<{ id: string; name: string }>(demo, 'admins').map((admin) => [admin.name, demoNumericId(admin.id)]),
  );
  const gatewayOf = new Map(gateways.map((gateway) => [gateway.driver, gateway]));
  const methodGateway: Record<DemoPayment['method'], string> = {
    card: 'card',
    usdt: 'crypto',
    bank: 'bank',
    wise: 'wise',
  };

  const paymentRows: Array<typeof s.payments.$inferInsert & { id: number }> = [];
  const invoiceRows: Array<typeof s.invoices.$inferInsert & { id: number }> = [];
  let skipped = 0;
  for (const demoPayment of demoRows<DemoPayment>(demo, 'payments')) {
    const merchant = merchants.get(demoPayment.mid);
    const gateway = gatewayOf.get(methodGateway[demoPayment.method]);
    if (!merchant || !gateway || !present.has(demoNumericId(merchant.id))) {
      skipped++;
      continue;
    }
    const id = demoNumericId(demoPayment.id);
    const invoiceId = id - 999;
    const created = toDate(demoPayment.created)!;
    const reviewedAt = toDate(demoPayment.reviewedAt);
    const approved = demoPayment.status === 'approved';
    invoiceRows.push({
      id: invoiceId,
      number: invoiceNumber(created.getUTCFullYear(), invoiceId),
      clientId: demoNumericId(merchant.id),
      kind: 'topup',
      amount: toMoney(demoPayment.gross),
      fee: toMoney(demoPayment.fee),
      netAmount: toMoney(demoPayment.net),
      taxAmount: toMoney(0),
      taxRate: '0',
      taxCountry: merchant.cc,
      total: toMoney(demoPayment.gross),
      currency: 'USD',
      status: approved ? 'paid' : demoPayment.status === 'rejected' ? 'void' : 'open',
      gatewayId: gateway.id,
      dueAt: new Date(created.getTime() + 14 * DAY_MS),
      paidAt: approved ? reviewedAt : null,
      createdAt: created,
      updatedAt: created,
    });
    paymentRows.push({
      id,
      invoiceId,
      purpose: 'topup',
      gatewayId: gateway.id,
      gatewayTxnId: demoPayment.ref || null,
      amount: toMoney(demoPayment.gross),
      feeAmount: toMoney(demoPayment.fee),
      currency: 'USD',
      status: demoPayment.status,
      methodType: topupMethodOf(gateway.driver, gateway.isManual),
      // A pending payment of an automatic gateway waits for staff: the job and risk have sent it to review.
      reviewRequired: demoPayment.status === 'pending' && !gateway.isManual,
      capturedAt: approved ? reviewedAt : null,
      reviewedBy: demoPayment.reviewedBy ? (staffIds.get(demoPayment.reviewedBy) ?? null) : null,
      reviewedAt,
      reviewNote: demoPayment.note || null,
      createdAt: created,
      updatedAt: reviewedAt ?? created,
    });
  }
  // Three manual invoices as staff would have issued them (the demo has none: the console mock makes them up). The first is cancelled
  // rather than paid, so no paid invoice lacks its deposit journal.
  const nextInvoice = invoiceRows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
  const manual = [
    { mid: 'm1', amount: 450, days: 21, status: 'void' as const, what: 'Annual API access fee' },
    { mid: 'm5', amount: 120, days: 9, status: 'open' as const, what: 'Priority support, October' },
    { mid: 'm11', amount: 900, days: 4, status: 'open' as const, what: 'Custom integration work' },
  ];
  manual.forEach((spec, index) => {
    const merchant = merchants.get(spec.mid);
    if (!merchant || !present.has(demoNumericId(merchant.id))) return;
    const id = nextInvoice + index;
    const created = new Date(demo.now - spec.days * DAY_MS);
    invoiceRows.push({
      id,
      number: invoiceNumber(created.getUTCFullYear(), id),
      clientId: demoNumericId(merchant.id),
      kind: 'manual',
      amount: toMoney(spec.amount),
      fee: toMoney(0),
      netAmount: toMoney(spec.amount),
      taxAmount: toMoney(0),
      taxRate: '0',
      taxCountry: merchant.cc,
      total: toMoney(spec.amount),
      currency: 'USD',
      status: spec.status,
      description: spec.what,
      dueAt: new Date(created.getTime() + 14 * DAY_MS),
      createdAt: created,
      updatedAt: created,
    });
  });
  if (skipped > 0) console.log(`  billing   skipped ${skipped} payments of merchants that are not in clients yet`);

  const invoiceReport = await insertRows(db, s.invoices, invoiceRows);
  const paymentReport = await insertRows(db, s.payments, paymentRows);
  const kycReport = await seedKyc(db, demo, merchants, present, staffIds);
  for (const table of [s.paymentGateways, s.invoices, s.payments, s.kycSubmissions]) await syncIdentity(db, table);
  return [gatewayReport, invoiceReport, paymentReport, kycReport];
}

/** The demo's gateways as rows (ids 1 to 4), with development credentials when the keyring is known. */
function gatewayRowsOf(rows: DemoGateway[], encryption: EncryptionService | undefined, now: number) {
  return rows.map((row, index) => {
    const driver = row.methods.split(',')[0]!.trim();
    const limits = LIMITS[driver] ?? LIMITS.card!;
    const fee = parseFee(row.fee);
    const isManual = row.mode === 'Manual';
    const secret = `sk_seed_${driver}_${(0x4000 + index * 0x137).toString(16)}`;
    return {
      id: demoNumericId(row.id),
      code: driver,
      driver,
      name: row.name,
      audience: AUDIENCE[row.audience] ?? ('b2c' as const),
      feePercent: toMoney(fee.percent),
      feeFixed: toMoney(fee.fixed),
      minAmount: toMoney(limits.min),
      maxAmount: toMoney(limits.max),
      allowedGroupIds: limits.groups,
      supportsRefunds: row.refunds,
      supports3ds: row.threeDS,
      isManual,
      instructions: row.desc,
      holdHours: limits.hold,
      isActive: row.on,
      configEnc: encryption && !isManual ? encryption.encrypt(JSON.stringify({ secret }), GATEWAY_CONFIG_AAD) : null,
      webhookSecretEnc:
        encryption && !isManual
          ? encryption.encrypt(`whsec_seed_${driver}_development_only`, GATEWAY_WEBHOOK_SECRET_AAD)
          : null,
      createdAt: new Date(now - (30 - index) * DAY_MS),
      updatedAt: new Date(now - (30 - index) * DAY_MS),
    };
  });
}

/**
 * Seeds one verification request per merchant (identity seeds `clients.kyc_status` approved for the demo's "Verified" and pending
 * for "In review"), so the Verification tab and the merchant row agree. The documents are not seeded.
 */
async function seedKyc(
  db: DbExecutor,
  demo: DemoSeed,
  merchants: Map<string, DemoMerchant>,
  present: Set<number>,
  staffIds: Map<string, number>,
): Promise<SeedReport> {
  const reviewer = [...staffIds.values()][0] ?? null;
  const rows: Array<typeof s.kycSubmissions.$inferInsert & { id: number }> = [];
  [...merchants.values()].forEach((merchant, index) => {
    const clientId = demoNumericId(merchant.id);
    if (!present.has(clientId)) return;
    const approved = merchant.kyc === 'Verified';
    const created = new Date(demo.now - (approved ? 20 + index : 1) * DAY_MS);
    rows.push({
      id: clientId,
      clientId,
      status: approved ? 'approved' : 'pending',
      fileIds: [],
      reviewedBy: approved ? reviewer : null,
      reviewedAt: approved ? new Date(created.getTime() + DAY_MS) : null,
      note: approved ? 'Documents match the trade licence.' : '',
      createdAt: created,
      updatedAt: created,
    });
  });
  return insertRows(db, s.kycSubmissions, rows);
}
