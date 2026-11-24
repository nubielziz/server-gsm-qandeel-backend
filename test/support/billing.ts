// Helpers for the billing tests (feature 8): a local server that plays a payment gateway's API, the policy that lets the drivers
// reach it, gateways with encrypted credentials, signed webhook deliveries, and rows for files, invoices and pending payments.
import { Global, Module } from '@nestjs/common';
import type { LightMyRequestResponse } from 'fastify';
import { Money } from '@src/common/money';
import { signWebhook } from '@src/infra/crypto';
import { EncryptionService } from '@src/infra/crypto';
import { type Database, schema as s } from '@src/infra/db';
import { GATEWAY_HTTP_POLICY, type GatewayHttpPolicy } from '@src/modules/money';
import { GATEWAY_CONFIG_AAD, GATEWAY_WEBHOOK_SECRET_AAD } from '@src/modules/money/application/gateway-credentials';
import type { TestApp } from './app';
import type { TestClock } from './clock';

/** The policy the tests give the gateway drivers: plain http to a local server is fine. */
export const testGatewayPolicy: GatewayHttpPolicy = { allowPrivateNetwork: true, httpsOnly: false };

/** Provides {@link testGatewayPolicy}. Import it with `createTestApp({ imports: [GatewayTestModule] })`. */
@Global()
@Module({ providers: [{ provide: GATEWAY_HTTP_POLICY, useValue: testGatewayPolicy }], exports: [GATEWAY_HTTP_POLICY] })
export class GatewayTestModule {}

/** One request the stand-in gateway received. */
export interface GatewayRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** What the record of a paid PaymentIntent says (decision 048: the automatic credit of a card top-up reads it before it credits). */
export interface FakeIntentRecord {
  /** What it collected (`amount_received`), in the currency's minor units. */
  readonly minor: number;
  /** The currency, any case (`usd` by default). */
  readonly currency?: string;
  /** `metadata.reference`: the invoice number its checkout was opened for; absent for a page opened before the record carried it. */
  readonly reference?: string;
  /** What its latest charge shows since the payment: refunded in full, the minor units refunded, disputed. */
  readonly charge?: { readonly refunded?: boolean; readonly amountRefunded?: number; readonly disputed?: boolean };
}

/**
 * A local HTTP server that plays the API of a card gateway (Stripe's checkout protocol) and of a crypto gateway: it records every
 * request, opens checkouts, and answers a status check from what the test sets.
 */
export class FakeGateway {
  readonly requests: GatewayRequest[] = [];
  /**
   * What `GET /v1/payment_intents/:id` and `GET /v1/invoices/:id` answer, by id (default: confirmed); a crypto invoice's record may also
   * state its amount, currency, coin, network and reference (decision 048), answered as given.
   */
  readonly status = new Map<
    string,
    {
      status: string;
      confirmations?: number;
      requiredConfirmations?: number;
      amount?: string;
      currency?: string;
      coin?: string;
      network?: string;
      reference?: string;
    }
  >();
  /**
   * The card of a PaymentIntent's latest Charge, by intent id, as `GET /v1/payment_intents/:id?expand[]=latest_charge` answers it
   * (feature 24C); an intent without one answers no charge.
   */
  readonly cards = new Map<string, { brand: string; last4: string; fingerprint: string; wallet?: string }>();
  /**
   * What the record of a PaymentIntent says it collected, by intent id, as `GET /v1/payment_intents/:id?expand[]=latest_charge` answers it
   * (with the status of {@link status}, `succeeded` by default); an intent without one states no amount.
   */
  readonly records = new Map<string, FakeIntentRecord>();
  /** When set, only the card details read (`?expand[]=latest_charge`) answers this status code. */
  failDetails: number | undefined;
  /** When set, every call answers this status code instead (a gateway that is down). */
  failWith: number | undefined;
  private readonly server: ReturnType<typeof Bun.serve>;
  private next = 1;

  constructor() {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        const url = new URL(request.url);
        const headers: Record<string, string> = {};
        request.headers.forEach((value, key) => {
          headers[key] = value;
        });
        this.requests.push({ method: request.method, path: url.pathname, headers, body: await request.text() });
        if (this.failWith) return new Response('{"error":"down"}', { status: this.failWith });
        const json = (body: unknown) => Response.json(body);
        if (request.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
          const id = `cs_${this.next++}`;
          return json({ id, url: `https://pay.example/${id}` });
        }
        if (request.method === 'POST' && url.pathname === '/v1/invoices') {
          const id = `cinv_${this.next++}`;
          return json({ id, url: `https://crypto.example/${id}` });
        }
        const intent = /^\/v1\/payment_intents\/(.+)$/.exec(url.pathname);
        if (intent) {
          const id = decodeURIComponent(intent[1]!);
          const status = this.status.get(id) ?? { status: 'succeeded' };
          if (!url.searchParams.has('expand[]')) return json(status);
          if (this.failDetails) return new Response('{"error":"no"}', { status: this.failDetails });
          const card = this.cards.get(id);
          const record = this.records.get(id);
          const charge = record?.charge;
          return json({
            id,
            ...status,
            ...(record === undefined
              ? {}
              : {
                  amount_received: record.minor,
                  currency: (record.currency ?? 'usd').toLowerCase(),
                  ...(record.reference === undefined ? {} : { metadata: { reference: record.reference } }),
                }),
            latest_charge:
              card || charge
                ? {
                    id: `ch_${id}`,
                    ...(charge
                      ? {
                          refunded: charge.refunded ?? false,
                          amount_refunded: charge.amountRefunded ?? 0,
                          disputed: charge.disputed ?? false,
                        }
                      : {}),
                    ...(card
                      ? {
                          payment_method_details: {
                            type: 'card',
                            card: {
                              brand: card.brand,
                              last4: card.last4,
                              fingerprint: card.fingerprint,
                              wallet: card.wallet ? { type: card.wallet } : null,
                            },
                          },
                        }
                      : {}),
                  }
                : null,
          });
        }
        const invoice = /^\/v1\/invoices\/(.+)$/.exec(url.pathname);
        if (invoice) {
          return json(
            this.status.get(decodeURIComponent(invoice[1]!)) ?? {
              status: 'confirmed',
              confirmations: 3,
              requiredConfirmations: 3,
            },
          );
        }
        return new Response('{}', { status: 404 });
      },
    });
  }

  /** The address of the server, as stored in a gateway's `apiBase`. */
  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /**
   * Records what the gateway's record of a paid PaymentIntent says.
   *
   * @param id the intent id
   * @param record what it collected, the reference its checkout named, and what its charge shows since
   */
  paid(id: string, record: FakeIntentRecord): void {
    this.records.set(id, record);
  }

  /** Forgets the requests and the scripted answers. */
  reset(): void {
    this.requests.length = 0;
    this.status.clear();
    this.cards.clear();
    this.records.clear();
    this.failDetails = undefined;
    this.failWith = undefined;
  }

  /** Stops the server. */
  async stop(): Promise<void> {
    await this.server.stop(true);
  }
}

/**
 * The API address of a test gateway that names none: a closed local port. A test never reaches the real gateway (without the test HTTP
 * policy the SSRF guard refuses it at once; with it the connection is refused at once), so a card confirmation's details read fails fast.
 */
export const UNREACHABLE_GATEWAY = 'http://127.0.0.1:9';

/** The signing key of the gateways of {@link insertGateway}. */
export const WEBHOOK_KEY = 'whsec_test_gateway_key_0123456789';

/** What {@link insertGateway} may override. */
export type GatewayOverrides = Partial<typeof s.paymentGateways.$inferInsert> & {
  readonly secret?: string | null;
  readonly webhookSecret?: string | null;
  readonly apiBase?: string;
};

/**
 * Inserts a payment gateway with its credentials encrypted the way the service stores them.
 *
 * @param t the running test app (for the encryption keyring)
 * @param db the test database
 * @param overrides columns to change; `secret`, `webhookSecret` and `apiBase` (default {@link UNREACHABLE_GATEWAY}) go into the
 *   encrypted columns
 * @returns the gateway id
 */
export async function insertGateway(t: TestApp, db: Database, overrides: GatewayOverrides = {}): Promise<number> {
  const encryption = t.app.get(EncryptionService);
  const { secret, webhookSecret, apiBase, ...columns } = overrides;
  const isManual = columns.isManual ?? false;
  const config =
    secret === null || isManual
      ? null
      : { secret: secret ?? 'sk_test_gateway_secret_1234', apiBase: apiBase ?? UNREACHABLE_GATEWAY };
  const [row] = await db
    .insert(s.paymentGateways)
    .values({
      code: `gw-${crypto.randomUUID().slice(0, 8)}`,
      driver: isManual ? 'bank' : 'card',
      name: 'Test gateway',
      audience: 'b2b',
      isManual,
      configEnc: config ? encryption.encrypt(JSON.stringify(config), GATEWAY_CONFIG_AAD) : null,
      webhookSecretEnc:
        webhookSecret === null || isManual
          ? null
          : encryption.encrypt(webhookSecret ?? WEBHOOK_KEY, GATEWAY_WEBHOOK_SECRET_AAD),
      ...columns,
    })
    .returning({ id: s.paymentGateways.id });
  return row!.id;
}

/**
 * Inserts a file row owned by an account, as the upload routes store it (area `files`; the upload route is feature 7a's; no object is stored).
 *
 * @param db the test database
 * @param clientId the owner (an account id)
 * @param overrides columns to change (mime, filename)
 * @returns the file id
 */
export async function insertProofFile(
  db: Database,
  clientId: number,
  overrides: Partial<typeof s.files.$inferInsert> = {},
): Promise<number> {
  const id = crypto.randomUUID();
  const [row] = await db
    .insert(s.files)
    .values({
      bucket: 'gsm-files-test',
      key: `files/test/${id}`,
      filename: 'receipt.pdf',
      mime: 'application/pdf',
      size: 1234,
      sha256: id.replaceAll('-', '').padEnd(64, '0'),
      ownerType: 'account',
      ownerId: clientId,
      ...overrides,
    })
    .returning({ id: s.files.id });
  return row!.id;
}

/**
 * Inserts an invoice row of a merchant-rank account (a top-up of its merchant wallet by default).
 *
 * Why: the owner column is `account_id`; `client_id` is still written for merchant invoices during the expand release, and a top-up or
 * manual invoice names the wallet kind it credits (`invoices_wallet_kind_check`).
 *
 * @param db the test database
 * @param clientId the account (a merchant)
 * @param overrides columns to change
 * @returns the invoice
 */
export async function insertInvoiceRow(
  db: Database,
  clientId: number,
  overrides: Partial<typeof s.invoices.$inferInsert> = {},
): Promise<typeof s.invoices.$inferSelect> {
  const number = `INV-2026-${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const amount = overrides.amount ?? '100.0000';
  const fee = overrides.fee ?? '0.0000';
  const [row] = await db
    .insert(s.invoices)
    .values({
      number,
      accountId: clientId,
      legacyClientId: clientId,
      kind: 'topup',
      ...(overrides.kind === undefined || overrides.kind === 'topup' || overrides.kind === 'manual'
        ? { walletKind: 'client_wallet' as const }
        : {}),
      amount,
      fee,
      netAmount: Money.of(amount).sub(Money.of(fee)).toWire(),
      total: amount,
      currency: 'USD',
      status: 'open',
      taxCountry: 'JO',
      ...overrides,
    })
    .returning();
  return row!;
}

/**
 * Inserts a pending top-up payment of an invoice (it belongs to the invoice's account).
 *
 * @param db the test database
 * @param invoice the invoice it pays
 * @param gatewayId the gateway
 * @param overrides columns to change
 * @returns the payment
 */
export async function insertPendingPayment(
  db: Database,
  invoice: typeof s.invoices.$inferSelect,
  gatewayId: number,
  overrides: Partial<typeof s.payments.$inferInsert> = {},
): Promise<typeof s.payments.$inferSelect> {
  const [row] = await db
    .insert(s.payments)
    .values({
      accountId: invoice.accountId,
      purpose: 'topup',
      invoiceId: invoice.id,
      gatewayId,
      amount: invoice.amount,
      feeAmount: invoice.fee,
      currency: invoice.currency,
      status: 'pending',
      methodType: 'bank',
      ...overrides,
    })
    .returning();
  return row!;
}

/** The headers of a signed delivery in the `t=<unix>,v1=<hmac>` scheme. */
export function signedHeaders(
  secret: string,
  body: string,
  clock: TestClock,
  header = 'stripe-signature',
  offsetSeconds = 0,
): Record<string, string> {
  const at = Math.floor(clock.nowMs() / 1000) + offsetSeconds;
  return { 'content-type': 'application/json', [header]: signWebhook(secret, at, body) };
}

/** A Stripe-style `checkout.session.completed` event for an invoice. */
export function cardEvent(
  eventId: string,
  invoiceNumber: string,
  overrides: { type?: string; reference?: string; amount?: number; currency?: string; paymentStatus?: string } = {},
): string {
  return JSON.stringify({
    id: eventId,
    type: overrides.type ?? 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${eventId}`,
        payment_intent: overrides.reference ?? `pi_${eventId}`,
        payment_status: overrides.paymentStatus ?? 'paid',
        client_reference_id: invoiceNumber,
        amount_total: overrides.amount,
        currency: overrides.currency ?? 'usd',
      },
    },
  });
}

/** Posts a delivery to `/webhooks/payments/:gateway`. */
export async function postWebhook(
  t: TestApp,
  gateway: string,
  body: string,
  headers: Record<string, string>,
): Promise<LightMyRequestResponse> {
  return t.app.inject({ method: 'POST', url: `/webhooks/payments/${gateway}`, headers, payload: body });
}
