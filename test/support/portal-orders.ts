// Helpers for the tests that call the merchant portal as a signed-in merchant and need an order row or the USD currency: an order the
// way the order engine writes it, and a portal client that keeps the session cookie and the CSRF token.
import type { LightMyRequestResponse } from 'fastify';
import { type Database, schema as s } from '@src/infra/db';
import type { TestApp } from './app';
import { openSession } from './auth';
import { insertCategory, insertService } from './catalog';
import { PORTAL_ORIGIN } from './merchant-portal';

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
