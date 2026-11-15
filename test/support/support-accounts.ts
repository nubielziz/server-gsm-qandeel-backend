// Helpers for the tests of the account surfaces of the support chat (feature 28, slice B2): a signed-in customer's calls, the counters of the
// `ticket-open` limiter, and stored files inserted straight into the table.
import { type LightMyRequestResponse } from 'fastify';
import { CacheKeys } from '../../src/infra/cache';
import { type Database, schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import type { TestApp } from './app';
import { openSession } from './auth';
import { STORE_ORIGIN } from './store';

/** One answer of the storefront: the parsed JSON next to the raw response. */
export interface StoreAnswer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON: the default keeps assertions short
  readonly body: any;
  readonly status: number;
  readonly res: LightMyRequestResponse;
}

/** A signed-in customer's calls to the storefront's session routes. */
export interface CustomerSession {
  readonly customerId: number;
  call(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<StoreAnswer>;
  /** Sends a mutation with the cookie but no CSRF token. */
  withoutCsrf(method: 'POST', url: string, payload?: unknown): Promise<StoreAnswer>;
}

/**
 * Opens a customer session and returns a client for the storefront's session routes.
 *
 * @param t the running test app
 * @param customerId the customer
 * @param ip the address the requests come from
 * @returns the client
 */
export async function customerSession(t: TestApp, customerId: number, ip = '127.0.0.1'): Promise<CustomerSession> {
  const session = await openSession(t, { type: 'customer', id: customerId });
  const send = async (
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ): Promise<StoreAnswer> => {
    const res = await t.app.inject({
      method,
      url,
      headers: { ...headers, origin: STORE_ORIGIN },
      remoteAddress: ip,
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
    return { body: res.body === '' ? undefined : JSON.parse(res.body), status: res.statusCode, res };
  };
  return {
    customerId,
    call: (method, url, payload) =>
      send(method, url, method === 'GET' ? session.headers : session.mutationHeaders, payload),
    withoutCsrf: (method, url, payload) => send(method, url, session.headers, payload),
  };
}

/**
 * Deletes the counters of the `ticket-open` limiter (5 tickets an hour per account).
 *
 * Why: the counters live an hour in the cache Redis, which outlives a test and a test run, and account ids start again after every `resetDb`.
 *
 * @param t the running test app
 */
export async function clearTicketOpenLimits(t: TestApp): Promise<void> {
  const redis = t.app.get(RedisService).cache;
  const found = await redis.keys(`${t.app.get(CacheKeys).rateLimit('ticket-open')}:*`);
  if (found.length > 0) await redis.del(...found);
}

/**
 * Inserts a file row straight into the table (an upload the platform made, of any type and size).
 *
 * @param db the test database
 * @param ownerType whose upload it is
 * @param ownerId the owner
 * @param values columns to override
 * @returns the stored row
 */
export async function insertFileRow(
  db: Database,
  ownerType: 'client' | 'staff' | 'customer',
  ownerId: number,
  values: Partial<typeof s.files.$inferInsert> = {},
) {
  const [row] = await db
    .insert(s.files)
    .values({
      bucket: 'gsm-files',
      key: `files/${crypto.randomUUID()}`,
      filename: 'upload.pdf',
      mime: 'application/pdf',
      size: 1000,
      sha256: 'a'.repeat(64),
      ownerType,
      ownerId,
      ...values,
    })
    .returning();
  return row!;
}
