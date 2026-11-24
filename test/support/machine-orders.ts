// Helpers for the tests of the merchants' machine surface (feature 7a): an API key and a Dhru username for a merchant, and a Dhru client that
// speaks the wire of decision 026. Every call comes from a fresh address, so the per-address limits of the pipeline never meet each other's
// counters.
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { CacheKeys, CacheService } from '@src/infra/cache';
import { type Database, schema as s } from '@src/infra/db';
import type { TestApp } from './app';
import { insertApiKey } from './machine-auth';
import { freshClientIp } from './pipeline-routes';

/** A merchant's machine credentials. */
export interface MachineCredentials {
  readonly clientId: number;
  /** The Dhru username (`clients.username`). */
  readonly username: string;
  /** The API key as the merchant holds it. */
  readonly key: string;
  readonly keyId: number;
}

/**
 * Gives a merchant-rank account an API key with a limit no test reaches.
 *
 * @param t the running test app
 * @param db the test database
 * @param clientId the merchant
 * @param overrides columns of the key to change (allowed IPs, limit, expiry, revocation)
 * @returns the username, the key and its id
 */
export async function credentialsFor(
  t: TestApp,
  db: Database,
  clientId: number,
  overrides: Partial<typeof s.apiKeys.$inferInsert> = {},
): Promise<MachineCredentials> {
  const [client] = await db.select({ username: s.clients.username }).from(s.clients).where(eq(s.clients.id, clientId));
  // the Dhru username exists for a merchant-rank account only (a retail account has none)
  if (!client?.username)
    throw new Error(`Account ${clientId} has no username: only a merchant has machine credentials.`);
  const { key, id } = await insertApiKey(t, db, clientId, { rateLimitPerMin: 100_000, ...overrides });
  return { clientId, username: client.username, key, keyId: id };
}

/** Forgets what the caches and limiters know about API keys (the database is reset between tests and key ids restart at 1). */
export async function clearApiKeyCaches(t: TestApp): Promise<void> {
  const cache = t.app.get(CacheService);
  const keys = t.app.get(CacheKeys);
  await cache.delByPrefix(keys.prefix('identity', 'api-key'));
  await cache.delByPrefix(keys.prefix('ratelimit', 'api-key'));
}

/** The JSON body of a response, typed loosely for assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON: the default keeps assertions short
export const body = (res: LightMyRequestResponse): any => res.json();

/** The parameters of a Dhru call as the wire carries them: base64 of a JSON object. */
export const dhruParameters = (parameters: unknown): string =>
  Buffer.from(JSON.stringify(parameters), 'utf8').toString('base64');

/** What a Dhru call may change. */
export interface DhruCallOptions {
  /** Credentials to send instead of the client's own. */
  readonly username?: string;
  readonly apiaccesskey?: string;
  /** The client address of the call. */
  readonly ip?: string;
  /** How the fields are sent (default `form`). */
  readonly as?: 'form' | 'json';
}

/**
 * A client of the Dhru endpoint.
 *
 * @param t the running test app
 * @param credentials the username and the key
 * @returns `call` (the parsed answer), `raw` (the whole response) and `multipart` (a multipart request)
 */
export function dhruClient(t: TestApp, credentials: Pick<MachineCredentials, 'username' | 'key'>) {
  const fields = (action: string, parameters: unknown, options: DhruCallOptions): Record<string, string> => ({
    username: options.username ?? credentials.username,
    apiaccesskey: options.apiaccesskey ?? credentials.key,
    action,
    requestformat: 'JSON',
    ...(parameters === undefined ? {} : { parameters: dhruParameters(parameters) }),
  });
  const raw = (action: string, parameters?: unknown, options: DhruCallOptions = {}) => {
    const form = fields(action, parameters, options);
    const remoteAddress = options.ip ?? freshClientIp();
    return options.as === 'json'
      ? t.app.inject({ method: 'POST', url: '/api/index.php', remoteAddress, payload: form })
      : t.app.inject({
          method: 'POST',
          url: '/api/index.php',
          remoteAddress,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: new URLSearchParams(form).toString(),
        });
  };
  const multipart = (
    action: string,
    parameters: unknown,
    file: { name: string; type: string; data: Uint8Array } | undefined,
    options: DhruCallOptions = {},
  ) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields(action, parameters, options))) form.set(name, value);
    if (file) form.set('file', new File([file.data], file.name, { type: file.type }));
    return multipartRequest(t, '/api/index.php', form, {}, options.ip);
  };
  return { raw, call: async (...args: Parameters<typeof raw>) => body(await raw(...args)), multipart };
}

/**
 * Sends a `multipart/form-data` request through Fastify's inject.
 *
 * @param t the running test app
 * @param url the route
 * @param form the form (text fields and files)
 * @param headers more headers (the session cookie)
 * @param ip the client address (a fresh one by default)
 * @returns the response
 */
export async function multipartRequest(
  t: TestApp,
  url: string,
  form: FormData,
  headers: Record<string, string> = {},
  ip?: string,
): Promise<LightMyRequestResponse> {
  const encoded = new Response(form);
  return t.app.inject({
    method: 'POST',
    url,
    remoteAddress: ip ?? freshClientIp(),
    headers: { ...headers, 'content-type': encoded.headers.get('content-type') ?? 'multipart/form-data' },
    payload: Buffer.from(await encoded.arrayBuffer()),
  });
}
