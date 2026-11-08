// Helpers for the storefront payment, refund and dispute tests (feature 16): a stand-in card gateway that opens checkouts, takes refunds and
// evidence, a B2C gateway row, and the whole storefront flow through the real API (open a checkout, consent, pay, signed confirmation).
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { DbService, type Database, schema as s } from '../../src/infra/db';
import { signWebhook } from '../../src/infra/crypto';
import { RECEIPT_RENDER_EVENT, ReceiptRenderProcessor, type ReceiptRenderResult } from '../../src/modules/money';
import type { TestApp } from './app';
import { type TestClock } from './clock';
import { WEBHOOK_KEY, insertGateway, postWebhook, signedHeaders } from './billing';
import { freshClientIp } from './pipeline-routes';
import { APPLE_IMEI, TURNSTILE_HEADERS, type StorefrontWorld, storefrontWorld } from './storefront';

/** One request the stand-in gateway received. */
export interface B2cRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * A local HTTP server that plays a card gateway's API for storefront money: it opens hosted checkouts, takes refunds (answering what the
 * test scripts) and evidence for disputes, and records every call.
 */
export class B2cGateway {
  readonly requests: B2cRequest[] = [];
  /** What `POST /v1/refunds` answers: a status and a failure text; `succeeded` by default. */
  refund: { status: string; failure?: string } = { status: 'succeeded' };
  /** When set, every call answers this status code (a gateway that is down). */
  failWith: number | undefined;
  /** When set, only the checkout call fails with this status. */
  failCheckout: number | undefined;
  private readonly server: ReturnType<typeof Bun.serve>;
  private next = 1;
  /** The hold the next checkout call waits for (see {@link holdCheckout}). */
  private hold: { arrived: () => void; gate: Promise<void> } | undefined;

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
        if (request.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
          if (this.failCheckout) return new Response('{"error":"no"}', { status: this.failCheckout });
          const hold = this.hold;
          this.hold = undefined;
          if (hold) {
            hold.arrived();
            await hold.gate;
          }
          const id = `cs_${this.next++}`;
          return Response.json({ id, url: `https://pay.example/${id}` });
        }
        if (request.method === 'POST' && url.pathname === '/v1/refunds') {
          const id = `re_${this.next++}`;
          return Response.json({ id, status: this.refund.status, failure_reason: this.refund.failure });
        }
        if (request.method === 'POST' && url.pathname.startsWith('/v1/disputes/'))
          return Response.json({ id: 'dp', status: 'under_review' });
        return new Response('{}', { status: 404 });
      },
    });
  }

  /** The address of the server, as stored in a gateway's `apiBase`. */
  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /**
   * Makes the next checkout call wait: the call arrives (`arrived` settles) and the answer is held until `release` runs. It plays a gateway
   * that is slow to open its page, so a test can act while a `/pay` call is still in flight, without sleeping.
   */
  holdCheckout(): { arrived: Promise<void>; release: () => void } {
    let arrive!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.hold = { arrived: arrive, gate };
    return { arrived, release };
  }

  /** The calls to one path. */
  calls(path: string): B2cRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  /** Forgets the requests and the scripted answers. */
  reset(): void {
    this.requests.length = 0;
    this.refund = { status: 'succeeded' };
    this.failWith = undefined;
    this.failCheckout = undefined;
    this.hold = undefined;
  }

  /** Stops the server. */
  async stop(): Promise<void> {
    await this.server.stop(true);
  }
}

/** What {@link b2cWorld} builds. */
export interface B2cWorld extends StorefrontWorld {
  /** The B2C card gateway (fee 2.9 % + 0.30, 3-D Secure, refunds). */
  readonly gateway: { id: number; code: string };
  readonly fake: B2cGateway;
}

/**
 * The storefront of feature 14a plus a B2C card gateway pointing at a stand-in gateway server.
 *
 * @param t the running test app
 * @param db the test database
 * @param fake the stand-in gateway
 * @returns the ids a test needs
 */
export async function b2cWorld(t: TestApp, db: Database, fake: B2cGateway): Promise<B2cWorld> {
  const world = await storefrontWorld(db);
  const code = 'card-b2c';
  const id = await insertGateway(t, db, {
    code,
    name: 'Card gateway',
    audience: 'b2c',
    apiBase: fake.url,
    supportsRefunds: true,
    supports3ds: true,
    feePercent: '2.9000',
    feeFixed: '0.3000',
  });
  return { ...world, gateway: { id, code }, fake };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON
export const json = (res: { json: () => any }): any => res.json();

/** Opens a checkout of the iCloud service in GBP and records the consents; returns the token and what the session locked. */
export async function openCheckout(
  t: TestApp,
  world: B2cWorld,
  options: {
    email?: string;
    serviceId?: number;
    consent?: boolean;
    currency?: string;
    quantity?: number;
    country?: string;
  } = {},
): Promise<{ token: string; session: ReturnType<typeof json> }> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/store/v1/checkout-sessions',
    headers: { 'user-agent': 'Mozilla/5.0 (test)', ...TURNSTILE_HEADERS },
    remoteAddress: freshClientIp(),
    payload: {
      serviceId: options.serviceId ?? world.icloud.serviceId,
      email: options.email ?? 'sam@mail.example',
      country: options.country ?? 'GB',
      currency: options.currency ?? 'GBP',
      imei: APPLE_IMEI,
      ...(options.quantity === undefined ? {} : { quantity: options.quantity }),
    },
  });
  if (res.statusCode !== 201) throw new Error(`open checkout answered ${res.statusCode}: ${res.body}`);
  const session = json(res);
  if (options.consent !== false) {
    const consents = await t.app.inject({
      method: 'POST',
      url: `/store/v1/checkout-sessions/${session.token}/consents`,
      headers: { 'user-agent': 'Mozilla/5.0 (test)' },
      remoteAddress: freshClientIp(),
      payload: {
        consents: [
          { purpose: 'terms', granted: true },
          { purpose: 'privacy', granted: true },
          { purpose: 'withdrawal_waiver', granted: true },
        ],
      } as never,
    });
    if (consents.statusCode !== 201) throw new Error(`consents answered ${consents.statusCode}: ${consents.body}`);
  }
  return { token: session.token, session };
}

/** `POST /store/v1/checkout-sessions/:token/pay`. */
export function pay(
  t: TestApp,
  token: string,
  body: Record<string, unknown> | undefined,
  key: string | null = crypto.randomUUID(),
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: 'POST',
    url: `/store/v1/checkout-sessions/${token}/pay`,
    headers: { 'user-agent': 'Mozilla/5.0 (test)', ...(key === null ? {} : { 'idempotency-key': key }) },
    remoteAddress: freshClientIp(),
    payload: (body ?? { gateway: 'card-b2c', returnUrl: 'https://shop.example/return' }) as never,
  });
}

/** The amount of a payment in the gateway's smallest unit. */
const minorOf = (amount: string): number => Math.round(Number(amount) * 100);

/** A Stripe-style `checkout.session.completed` for a storefront payment, with what the gateway read about the card. */
export function storefrontEvent(
  eventId: string,
  reference: string,
  options: {
    amount: string;
    currency?: string;
    type?: string;
    paymentStatus?: string;
    intent?: string;
    card?: { brand: string; last4: string; fingerprint?: string; threeDs?: boolean; wallet?: string };
  },
): string {
  const card = options.card ?? { brand: 'visa', last4: '4242', fingerprint: 'fp_1', threeDs: true };
  return JSON.stringify({
    id: eventId,
    type: options.type ?? 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${eventId}`,
        payment_intent: options.intent ?? `pi_${eventId}`,
        payment_status: options.paymentStatus ?? 'paid',
        client_reference_id: reference,
        amount_total: minorOf(options.amount),
        currency: (options.currency ?? 'gbp').toLowerCase(),
        payment_method_details: {
          type: 'card',
          card: {
            brand: card.brand,
            last4: card.last4,
            fingerprint: card.fingerprint ?? 'fp_1',
            ...(card.threeDs === false ? {} : { three_d_secure: { result: 'authenticated' } }),
            ...(card.wallet ? { wallet: { type: card.wallet } } : {}),
          },
        },
      },
    },
  });
}

/** Posts a signed delivery to the payment or the dispute webhook of a gateway. */
export function hook(
  t: TestApp,
  clock: TestClock,
  kind: 'payments' | 'disputes',
  gatewayCode: string,
  body: string,
): Promise<LightMyRequestResponse> {
  if (kind === 'payments') return postWebhook(t, gatewayCode, body, signedHeaders(WEBHOOK_KEY, body, clock));
  return t.app.inject({
    method: 'POST',
    url: `/webhooks/disputes/${gatewayCode}`,
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signWebhook(WEBHOOK_KEY, Math.floor(clock.nowMs() / 1000), body),
    },
    payload: body,
  });
}

/** A signed dispute event. */
export function disputeEvent(
  eventId: string,
  options: {
    dispute: string;
    intent: string;
    type?: string;
    status?: string;
    amount?: number;
    fee?: number;
    reason?: string;
    dueBy?: number;
  },
): string {
  return JSON.stringify({
    id: eventId,
    type: options.type ?? 'charge.dispute.created',
    data: {
      object: {
        id: options.dispute,
        payment_intent: options.intent,
        amount: options.amount ?? 384,
        currency: 'gbp',
        fee: options.fee ?? 1200,
        reason: options.reason ?? 'fraudulent',
        status: options.status ?? 'needs_response',
        ...(options.dueBy === undefined ? {} : { evidence_details: { due_by: options.dueBy } }),
      },
    },
  });
}

/** A refund result event. */
export function refundEvent(
  eventId: string,
  options: {
    refund: string;
    refundId?: number;
    /** The send attempt the gateway echoes from the refund call's metadata. */
    sendAttempt?: number;
    type?: 'refund.succeeded' | 'refund.failed';
    failure?: string;
  },
): string {
  return JSON.stringify({
    id: eventId,
    type: options.type ?? 'refund.succeeded',
    data: {
      object: {
        id: options.refund,
        failure_reason: options.failure,
        ...(options.refundId === undefined
          ? {}
          : {
              metadata: {
                refund_id: String(options.refundId),
                ...(options.sendAttempt === undefined ? {} : { send_attempt: String(options.sendAttempt) }),
              },
            }),
      },
    },
  });
}

/** What {@link paidOrder} returns. */
export interface PaidOrder {
  readonly token: string;
  readonly trackingToken: string;
  readonly orderId: number;
  readonly paymentId: number;
  readonly reference: string;
  /** The gateway's id of the payment (`payments.gateway_txn_id`). */
  readonly intent: string;
  /** The amount charged, in GBP. */
  readonly charged: string;
}

let eventCounter = 0;

/**
 * Runs the whole storefront flow: a checkout, its consents, a payment and the gateway's signed confirmation; the order exists afterwards.
 *
 * @param t the running test app
 * @param clock the test clock
 * @param world the storefront and gateway
 * @param options the buyer's email, the service and the card the event reports
 * @returns the order and the payment
 */
export async function paidOrder(
  t: TestApp,
  clock: TestClock,
  world: B2cWorld,
  options: {
    email?: string;
    serviceId?: number;
    country?: string;
    currency?: string;
    card?: { brand: string; last4: string; fingerprint?: string; threeDs?: boolean; wallet?: string };
  } = {},
): Promise<PaidOrder> {
  const { token } = await openCheckout(t, world, options);
  const started = await pay(t, token, undefined);
  if (started.statusCode !== 201) throw new Error(`pay answered ${started.statusCode}: ${started.body}`);
  const { payment } = json(started);
  eventCounter += 1;
  const intent = `pi_paid_${eventCounter}_${crypto.randomUUID().slice(0, 6)}`;
  const body = storefrontEvent(`evt_paid_${eventCounter}_${crypto.randomUUID().slice(0, 6)}`, payment.reference, {
    amount: payment.amount,
    currency: payment.currency,
    intent,
    ...(options.card === undefined ? {} : { card: options.card }),
  });
  const confirmed = await hook(t, clock, 'payments', world.gateway.code, body);
  if (confirmed.statusCode !== 200) throw new Error(`webhook answered ${confirmed.statusCode}: ${confirmed.body}`);
  const shown = await t.app.inject({
    method: 'GET',
    url: `/store/v1/checkout-sessions/${token}`,
    remoteAddress: freshClientIp(),
  });
  const session = json(shown);
  if (session.status !== 'paid') throw new Error(`the checkout is ${session.status} after the confirmation`);
  const [order] = await world.db.select().from(s.orders).where(eq(s.orders.publicToken, session.trackingToken));
  return {
    token,
    trackingToken: session.trackingToken,
    orderId: order!.id,
    paymentId: payment.id,
    reference: payment.reference,
    intent,
    charged: payment.amount,
  };
}

/**
 * Runs the `receipt.render` job of every receipt the captures queued, as the worker would (the test app has no worker): the PDF of each is
 * drawn and stored. The test app must import `ReceiptRenderModule`.
 *
 * @param t the running test app
 * @returns what each job did, in the order of the outbox events; a storage failure rejects
 */
export async function renderReceipts(t: TestApp): Promise<ReceiptRenderResult[]> {
  const events = await t.app
    .get(DbService, { strict: false })
    .db.select()
    .from(s.outboxEvents)
    .where(eq(s.outboxEvents.type, RECEIPT_RENDER_EVENT))
    .orderBy(s.outboxEvents.id);
  const processor = t.app.get(ReceiptRenderProcessor, { strict: false });
  const results: ReceiptRenderResult[] = [];
  for (const event of events) {
    const data = {
      eventId: event.id,
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
      requestId: `test-${event.id}`,
    };
    results.push(await processor.process({ name: event.type, data } as never));
  }
  return results;
}
