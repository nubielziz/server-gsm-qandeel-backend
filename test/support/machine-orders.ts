// Helpers for the tests of the merchants' machine surfaces (feature 7a): an API key and a Dhru username for a merchant, a Dhru client that
// speaks the wire of decision 026, and a REST v1 client that sends the Bearer key. Every call comes from a fresh address, so the per-address
// limits of the pipeline never meet each other's counters.
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { CacheKeys, CacheService } from '../../src/infra/cache';
import { type Database, schema as s } from '../../src/infra/db';
import type { TestApp } from './app';
import { insertApiKey } from './machine-auth';
import { freshClientIp } from './pipeline-routes';

/** Every scope a merchant key may carry. */
export const ALL_SCOPES = ['dhru', 'services:read', 'account:read', 'orders:read', 'orders:write'] as const;

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
 * Gives a merchant an API key with every scope and a limit no test reaches.
 *
 * @param t the running test app
 * @param db the test database
 * @param clientId the merchant
 * @param overrides columns of the key to change (scopes, allowed IPs, limit, expiry, revocation)
 * @returns the username, the key and its id
 */
export async function credentialsFor(
  t: TestApp,
  db: Database,
  clientId: number,
  overrides: Partial<typeof s.apiKeys.$inferInsert> = {},
): Promise<MachineCredentials> {
  const [client] = await db.select({ username: s.clients.username }).from(s.clients).where(eq(s.clients.id, clientId));
  const { key, id } = await insertApiKey(t, db, clientId, {
    scopes: [...ALL_SCOPES],
    rateLimitPerMin: 100_000,
    ...overrides,
  });
  return { clientId, username: client!.username, key, keyId: id };
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
 * @param headers more headers (the Bearer key, the session cookie)
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

/**
 * A client of REST v1.
 *
 * @param t the running test app
 * @param key the API key (`undefined` sends no `Authorization` header)
 * @returns `get`, `post` (JSON) and `upload` (multipart), each answering the whole response
 */
export function v1Client(t: TestApp, key: string | undefined) {
  const auth = (extra: Record<string, string> = {}, ip?: string) => ({
    remoteAddress: ip ?? freshClientIp(),
    headers: { ...(key === undefined ? {} : { authorization: `Bearer ${key}` }), ...extra },
  });
  return {
    get: (url: string, extra: Record<string, string> = {}, ip?: string) =>
      t.app.inject({ method: 'GET', url, ...auth(extra, ip) }),
    post: (url: string, payload: unknown = undefined, extra: Record<string, string> = {}, ip?: string) =>
      t.app.inject({
        method: 'POST',
        url,
        ...auth(extra, ip),
        ...(payload === undefined ? {} : { payload: payload as never }),
      }),
    upload: (
      url: string,
      file: { name: string; type: string; data: Uint8Array } | undefined,
      extra: Record<string, string> = {},
    ) => {
      const form = new FormData();
      if (file) form.set('file', new File([file.data], file.name, { type: file.type }));
      return multipartRequest(t, url, form, auth(extra).headers);
    },
  };
}
