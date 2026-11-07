// Helpers for the webhook tests (feature 7b): a local server that stands in for a merchant's endpoint and records what it gets,
// the test policy that lets the sender reach it, and rows for the foreign tables an event reads (orders, invoices).
import { Global, Module } from '@nestjs/common';
import type { LightMyRequestResponse } from 'fastify';
import { type Database, schema as s } from '../../src/infra/db';
import { EncryptionService } from '../../src/infra/crypto';
import { WEBHOOK_TARGET_POLICY, type WebhookTargetPolicy } from '../../src/modules/platform';
import { WEBHOOK_SECRET_AAD } from '../../src/modules/platform/webhooks/webhook-deliveries';
import type { TestApp } from './app';
import { openSession } from './auth';
import { insertCategory, insertService } from './catalog';
import { PORTAL_ORIGIN } from './merchant-portal';

/** One request the stand-in endpoint received. */
export interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  /** The exact body text: the signature covers it. */
  readonly body: string;
}

/** What the stand-in endpoint answers next. */
export type ScriptedAnswer = number | { readonly status: number; readonly body?: string } | 'hang' | 'close';

/**
 * A local HTTP server that plays the merchant's endpoint: it records every request and answers from a script (`200` when the
 * script is empty).
 */
export class WebhookReceiver {
  readonly requests: ReceivedRequest[] = [];
  private readonly script: ScriptedAnswer[] = [];
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        const body = await request.text();
        const headers: Record<string, string> = {};
        request.headers.forEach((value, key) => {
          headers[key] = value;
        });
        this.requests.push({ method: request.method, path: new URL(request.url).pathname, headers, body });
        const next = this.script.shift() ?? 200;
        if (next === 'hang') return new Promise<Response>(() => undefined);
        if (next === 'close') return new Response(null, { status: 200, headers: { connection: 'close' } });
        const { status, body: text } = typeof next === 'number' ? { status: next, body: '{"ok":true}' } : next;
        return new Response(text ?? '', { status });
      },
    });
  }

  /** The address of the server, as a merchant would register it (plain http: the test policy allows it). */
  get url(): string {
    return `http://127.0.0.1:${this.server.port}/hooks/gsm`;
  }

  /** Queues the answers for the next requests, in order. */
  answer(...answers: ScriptedAnswer[]): void {
    this.script.push(...answers);
  }

  /** Forgets the requests and the script. */
  reset(): void {
    this.requests.length = 0;
    this.script.length = 0;
  }

  /** Stops the server. */
  async stop(): Promise<void> {
    await this.server.stop(true);
  }
}

/**
 * The policy the tests give the sender: a stand-in DNS that resolves every name to a public address (so the save-time check passes
 * for `https://hooks.example.com`), private addresses and plain http allowed (so the local receiver can be reached). A test of the
 * SSRF guard at send time switches `allowPrivateNetwork` off. The object is shared and mutable on purpose: the services read it
 * on every call.
 */
export const testWebhookPolicy: { -readonly [K in keyof WebhookTargetPolicy]: WebhookTargetPolicy[K] } = {
  lookup: (host: string) => Promise.resolve(host.startsWith('private.') ? ['10.0.0.5'] : ['93.184.216.34']),
  allowPrivateNetwork: true,
  httpsOnly: false,
};

/** Puts the policy back to what `testWebhookPolicy` starts as. */
export function resetWebhookPolicy(): void {
  testWebhookPolicy.allowPrivateNetwork = true;
  testWebhookPolicy.httpsOnly = false;
}

/**
 * Provides the test policy to the app. Import it with `createTestApp({ imports: [WebhookTestModule] })`. (`invoice.paid` is
 * registered in production by the money module, feature 8: it needs no test route.)
 */
@Global()
@Module({
  providers: [{ provide: WEBHOOK_TARGET_POLICY, useValue: testWebhookPolicy }],
  exports: [WEBHOOK_TARGET_POLICY],
})
export class WebhookTestModule {}

/** The secret every endpoint of {@link insertEndpoint} signs with. */
export const TEST_ENDPOINT_SECRET = 'whsec_test_endpoint_secret_0123456789';

/**
 * Inserts a webhook endpoint with a known signing secret, stored encrypted the way the service stores it.
 *
 * @param encryption the app's encryption service
 * @param db the test database
 * @param clientId the merchant
 * @param overrides columns to change (url, events, switch, failure count)
 * @returns the endpoint id
 */
export async function insertEndpoint(
  encryption: EncryptionService,
  db: Database,
  clientId: number,
  overrides: Partial<typeof s.webhookEndpoints.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(s.webhookEndpoints)
    .values({
      clientId,
      url: 'https://hooks.example.com/gsm',
      secretEnc: encryption.encrypt(TEST_ENDPOINT_SECRET, WEBHOOK_SECRET_AAD),
      events: ['order.status_changed'],
      isActive: true,
      ...overrides,
    })
    .returning({ id: s.webhookEndpoints.id });
  return row!.id;
}

/** Inserts USD (the currency of orders and invoices) when it is missing. */
export async function insertUsd(db: Database): Promise<void> {
  await db
    .insert(s.currencies)
    .values({ code: 'USD', name: 'US dollar', rateToBase: '1', decimals: 2 })
    .onConflictDoNothing();
}

/**
 * Inserts an order of a merchant (a row of feature 5's table, as the order engine will write it).
 *
 * @param db the test database
 * @param clientId the merchant
 * @param overrides columns to change
 * @returns the order id and its service
 */
export async function insertOrder(
  db: Database,
  clientId: number,
  overrides: Partial<typeof s.orders.$inferInsert> & { readonly serviceName?: string } = {},
): Promise<{ orderId: number; serviceId: number }> {
  await insertUsd(db);
  const { serviceName, ...columns } = overrides;
  const serviceId =
    columns.serviceId ?? (await insertService(db, await insertCategory(db), serviceName ? { name: serviceName } : {}));
  const [row] = await db
    .insert(s.orders)
    .values({
      clientId,
      serviceId,
      type: 'imei',
      source: 'v1',
      status: 'completed',
      dispatchState: 'done',
      imei: '356938035643809',
      unitPrice: '4.5000',
      totalPrice: '4.5000',
      unitCost: '3.0000',
      totalCost: '3.0000',
      currency: 'USD',
      resultCode: 'CLEAN',
      resultComment: 'Device is clean',
      placedAt: new Date('2026-11-01T09:30:00.000Z'),
      completedAt: new Date('2026-11-01T09:42:10.000Z'),
      adminNote: 'internal: supplier was slow',
      ...columns,
    })
    .returning({ id: s.orders.id });
  return { orderId: row!.id, serviceId };
}

/** One answer of the portal: the parsed JSON next to the raw response. */
export interface PortalAnswer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON: the default keeps assertions short
  readonly body: any;
  readonly status: number;
  readonly res: LightMyRequestResponse;
  /** The `x-total-count` header as a number (`NaN` when absent). */
  readonly total: number;
}

/** A signed-in merchant's calls to the portal routes, by session cookie and CSRF token. */
export interface PortalClient {
  readonly clientId: number;
  call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<PortalAnswer>;
  /** Sends a mutation with the cookie but no CSRF token. */
  withoutCsrf(method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<PortalAnswer>;
}

/**
 * Opens a merchant session and returns a client for the portal routes.
 *
 * @param t the running test app
 * @param clientId the merchant
 * @param ip the address the requests come from
 * @returns the client
 */
export async function portalFor(t: TestApp, clientId: number, ip = '127.0.0.1'): Promise<PortalClient> {
  const session = await openSession(t, { type: 'client', id: clientId });
  const send = async (
    method: string,
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ): Promise<PortalAnswer> => {
    const res = await t.app.inject({
      method: method as 'GET',
      url,
      headers: { ...headers, origin: PORTAL_ORIGIN },
      remoteAddress: ip,
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
    return {
      body: res.body === '' ? undefined : JSON.parse(res.body),
      status: res.statusCode,
      res,
      total: Number(res.headers['x-total-count'] ?? Number.NaN),
    };
  };
  return {
    clientId,
    call: (method, url, payload) =>
      send(method, url, method === 'GET' ? session.headers : session.mutationHeaders, payload),
    withoutCsrf: (method, url, payload) => send(method, url, session.headers, payload),
  };
}

/** Inserts a delivery row the way the fan-out writes it (a pending first attempt unless told otherwise). */
export async function insertDelivery(
  db: Database,
  endpointId: number,
  overrides: Partial<typeof s.webhookDeliveries.$inferInsert> = {},
): Promise<number> {
  const eventId = overrides.eventId ?? `evt_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const event = overrides.event ?? 'order.status_changed';
  const [row] = await db
    .insert(s.webhookDeliveries)
    .values({
      endpointId,
      event,
      eventId,
      payload: {
        id: eventId,
        type: event,
        createdAt: '2026-11-01T09:42:10.000Z',
        data: { orderId: 48102, status: 'completed' },
      },
      attempt: 1,
      status: 'pending',
      nextRetryAt: new Date('2026-11-01T10:00:00.000Z'),
      ...overrides,
    })
    .returning({ id: s.webhookDeliveries.id });
  return row!.id;
}
