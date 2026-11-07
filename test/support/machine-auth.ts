// Sample routes, stand-in resolvers and a test webhook adapter for the machine-auth tests (P2.5c): one contract per machine access
// kind, so the guards are tested through real HTTP. Keys live under /t/mach to stay unique. Handlers answer what the guard made
// of the request.
import { Body, Controller } from '@nestjs/common';
import { z } from 'zod';
import { type ResultOf, Route, defineRoute, zJsonObject } from '../../src/common/contract';
import { AppError } from '../../src/common/errors';
import { TokenService, signWebhook, verifyWebhookSignature } from '../../src/infra/crypto';
import { type Database, schema as s } from '../../src/infra/db';
import {
  CurrentPrincipal,
  type CapabilityAccessKind,
  type CapabilityTokenResolver,
  type Principal,
  type VerifiedDelivery,
  type WebhookDelivery,
  type WebhookVerifier,
} from '../../src/modules/identity';
import type { TestApp } from './app';

const Seen = z.object({
  ok: z.boolean(),
  kind: z.string().nullable(),
  clientId: z.number().nullable(),
  keyId: z.number().nullable(),
  scopes: z.array(z.string()),
  resourceId: z.number().nullable(),
  gateway: z.string().nullable(),
  eventId: z.string().nullable(),
  duplicate: z.boolean().nullable(),
});
const Okay = z.object({ ok: z.boolean() });

/** REST v1 routes: a read and a write, each with the scope it needs. */
export const v1Read = defineRoute({
  key: 'GET /v1/t/mach/read',
  summary: 'A REST v1 read (needs orders:read)',
  tags: ['machine-test'],
  surface: 'v1',
  access: 'api-key',
  permission: 'orders:read',
  success: { status: 200, schema: Seen },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'IP_NOT_ALLOWED', 'ACCOUNT_SUSPENDED', 'RATE_LIMITED'],
});
export const v1Write = defineRoute({
  key: 'POST /v1/t/mach/write',
  summary: 'A REST v1 write (needs orders:write)',
  tags: ['machine-test'],
  surface: 'v1',
  access: 'api-key',
  permission: 'orders:write',
  body: zJsonObject,
  success: { status: 201, schema: Seen },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'IP_NOT_ALLOWED', 'ACCOUNT_SUSPENDED', 'RATE_LIMITED'],
});

/** Storefront routes with a capability token in the path, and one with the token in the body. */
function tokenRoute<K extends CapabilityAccessKind>(kind: K, segment: string) {
  return defineRoute({
    key: `GET /store/v1/t/mach/${segment}/:token`,
    summary: `A route with access ${kind}`,
    tags: ['machine-test'],
    surface: 'store',
    access: kind,
    params: z.object({ token: z.string() }),
    success: { status: 200, schema: Seen },
    errors: ['NOT_FOUND', 'TOKEN_INVALID'],
  });
}
export const checkoutRoute = tokenRoute('checkout-token', 'checkout');
export const trackingRoute = tokenRoute('tracking-token', 'orders');
export const ticketRoute = tokenRoute('ticket-token', 'tickets');
export const linkRoute = defineRoute({
  key: 'POST /store/v1/t/mach/link',
  summary: 'A sign-in link route (the token is in the body)',
  tags: ['machine-test'],
  surface: 'store',
  access: 'link-token',
  body: z.object({ token: z.string() }),
  success: { status: 200, schema: Seen },
  errors: ['TOKEN_INVALID'],
});

/** Webhook routes: a secret in the URL, and a signed delivery to a gateway. */
export const URL_SECRET_ROUTE_KEY = 'POST /webhooks/t/mach/telegram/:secret';
export const urlSecretRoute = defineRoute({
  key: URL_SECRET_ROUTE_KEY,
  summary: 'A webhook with a secret in the URL',
  tags: ['machine-test'],
  surface: 'hooks',
  access: 'url-secret',
  params: z.object({ secret: z.string() }),
  body: zJsonObject,
  success: { status: 200, schema: Okay },
  errors: ['UNAUTHORIZED'],
});
export const gatewayRoute = defineRoute({
  key: 'POST /webhooks/t/mach/pay/:gateway',
  summary: 'A signed gateway webhook',
  tags: ['machine-test'],
  surface: 'hooks',
  access: 'gateway-signature',
  params: z.object({ gateway: z.string() }),
  body: zJsonObject,
  success: { status: 200, schema: Seen },
  errors: ['WEBHOOK_SIGNATURE_INVALID'],
});

function seen(principal: Principal | undefined): z.infer<typeof Seen> {
  const empty = {
    ok: true,
    kind: principal?.kind ?? null,
    clientId: null,
    keyId: null,
    scopes: [] as string[],
    resourceId: null,
    gateway: null,
    eventId: null,
    duplicate: null,
  };
  if (principal?.kind === 'api-key') {
    return { ...empty, clientId: principal.clientId, keyId: principal.keyId, scopes: [...principal.scopes] };
  }
  if (principal?.kind === 'capability') return { ...empty, resourceId: principal.resourceId };
  if (principal?.kind === 'webhook') {
    return { ...empty, gateway: principal.gateway, eventId: principal.eventId, duplicate: principal.duplicate };
  }
  return empty;
}

/** Handlers of the machine-auth sample routes. */
@Controller()
export class MachineTestController {
  @Route(v1Read)
  v1Read(@CurrentPrincipal() principal: Principal | undefined): ResultOf<typeof v1Read> {
    return seen(principal);
  }

  @Route(v1Write)
  v1Write(@CurrentPrincipal() principal: Principal | undefined): ResultOf<typeof v1Write> {
    return seen(principal);
  }

  @Route(checkoutRoute)
  checkout(@CurrentPrincipal() principal: Principal | undefined): ResultOf<typeof checkoutRoute> {
    return seen(principal);
  }

  @Route(trackingRoute)
  tracking(@CurrentPrincipal() principal: Principal | undefined): ResultOf<typeof trackingRoute> {
    return seen(principal);
  }

  @Route(ticketRoute)
  ticket(@CurrentPrincipal() principal: Principal | undefined): ResultOf<typeof ticketRoute> {
    return seen(principal);
  }

  @Route(linkRoute)
  link(@CurrentPrincipal() principal: Principal | undefined): ResultOf<typeof linkRoute> {
    return seen(principal);
  }

  @Route(urlSecretRoute)
  urlSecret(): ResultOf<typeof urlSecretRoute> {
    return { ok: true };
  }

  @Route(gatewayRoute)
  gateway(
    @CurrentPrincipal() principal: Principal | undefined,
    @Body() body: Record<string, unknown>,
  ): ResultOf<typeof gatewayRoute> {
    // A delivery asking for it fails after the guard, like a handler that hit a database outage.
    if (body.fail === true) throw new Error('The handler failed after the signature was accepted.');
    return seen(principal);
  }
}

/** A capability token resolver backed by a fixed table of token to id. */
export function staticResolver(kind: CapabilityAccessKind, tokens: Record<string, number>): CapabilityTokenResolver {
  return { kind, resolve: (token) => (token in tokens ? { id: tokens[token]! } : null) };
}

/** A random token in the shape of ours (22 characters of base64url). */
export function randomCapabilityToken(t: TestApp): string {
  return t.app.get(TokenService).random(16);
}

/** The gateway slug of the test webhook adapter. */
export const TEST_GATEWAY = 'testpay';
/** The secret the test adapter signs with. */
export const TEST_GATEWAY_SECRET = 'whsec_test_secret_of_the_test_gateway';
/** The header the test adapter reads its signature from (`t=<unix>,v1=<hex>`, our own scheme). */
export const TEST_SIGNATURE_HEADER = 'x-test-signature';

/**
 * A webhook adapter for the tests: our `t=...,v1=...` scheme over the raw body, with the event id read from the signed JSON.
 *
 * The adapter checks the signature only; the window and the replay filter belong to the guard, so it accepts any time.
 */
export const testWebhookVerifier: WebhookVerifier = {
  gateway: TEST_GATEWAY,
  verify(delivery: WebhookDelivery): VerifiedDelivery {
    const header = delivery.headers[TEST_SIGNATURE_HEADER];
    if (typeof header !== 'string') throw new AppError('WEBHOOK_SIGNATURE_INVALID', { detail: 'No signature header.' });
    const result = verifyWebhookSignature(TEST_GATEWAY_SECRET, header, delivery.rawBody, {
      nowSeconds: delivery.nowSeconds,
      toleranceSeconds: Number.POSITIVE_INFINITY,
    });
    if (!result.valid) throw new AppError('WEBHOOK_SIGNATURE_INVALID', { detail: result.reason });
    const event: unknown = JSON.parse(delivery.rawBody.toString('utf8'));
    const id = (event as { id?: unknown }).id;
    if (typeof id !== 'string') throw new AppError('WEBHOOK_SIGNATURE_INVALID', { detail: 'No event id.' });
    return { eventId: id, timestamp: result.timestamp };
  },
};

/**
 * Builds a signed test delivery.
 *
 * @param body the JSON body (its `id` is the event id)
 * @param timestamp the signed time in unix seconds (from the test clock: the guard judges it against the app's clock)
 * @param secret the secret to sign with (default the gateway's)
 * @returns the exact body text and the headers a gateway would send
 */
export function signedDelivery(
  body: Record<string, unknown>,
  timestamp: number,
  secret = TEST_GATEWAY_SECRET,
): { payload: string; headers: Record<string, string> } {
  const payload = JSON.stringify(body);
  return {
    payload,
    headers: { 'content-type': 'application/json', [TEST_SIGNATURE_HEADER]: signWebhook(secret, timestamp, payload) },
  };
}

/** What {@link insertApiKey} makes. */
export interface InsertedApiKey {
  readonly id: number;
  /** The key as a merchant would hold it (the database holds only its hash). */
  readonly key: string;
  readonly keyHash: string;
}

/**
 * Inserts an API key for a merchant, stored the way decision 019 says: only the keyed hash and the display prefix.
 *
 * @param t the running test app (for the token pepper)
 * @param db the test database
 * @param clientId the merchant
 * @param overrides columns to change (scopes, allowed IPs, limit, expiry, revocation)
 * @returns the id, the key and its hash
 */
export async function insertApiKey(
  t: TestApp,
  db: Database,
  clientId: number,
  overrides: Partial<typeof s.apiKeys.$inferInsert> = {},
): Promise<InsertedApiKey> {
  const tokens = t.app.get(TokenService);
  const key = `gsm_${tokens.random(32)}`;
  const keyHash = tokens.hash(key);
  const [row] = await db
    .insert(s.apiKeys)
    .values({
      clientId,
      name: 'Test key',
      prefix: key.slice(0, 8),
      keyHash,
      scopes: ['orders:read', 'orders:write', 'dhru'],
      allowedIps: [],
      rateLimitPerMin: 60,
      ...overrides,
    })
    .returning({ id: s.apiKeys.id });
  return { id: row!.id, key, keyHash };
}
