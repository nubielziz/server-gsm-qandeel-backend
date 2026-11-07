// A small client for the admin routes in tests: it holds a signed-in staff session (cookie + CSRF token) and the address the
// requests come from, and offers get/post/patch/put/delete that answer the parsed JSON next to the raw response.
import type { LightMyRequestResponse } from 'fastify';
import { type TestApp } from './app';
import { type TestSession, insertRole, insertStaff, openSession } from './auth';
import { CONSOLE_ORIGIN } from './staff-console';
import { testDb } from './db';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** One answer of the API. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON: the default keeps assertions short
export interface ApiAnswer<T = any> {
  readonly body: T;
  readonly status: number;
  readonly res: LightMyRequestResponse;
  /** The `x-total-count` header as a number (`NaN` when absent). */
  readonly total: number;
}

/** A staff member who is signed in, with a client for the admin routes. */
export class AdminApi {
  constructor(
    private readonly t: TestApp,
    readonly session: TestSession,
    readonly staffId: number,
    readonly roleId: number,
    /** The address the requests come from (what the IP rules judge). */
    readonly ip = '127.0.0.1',
  ) {}

  /** Sends a request with this session. */
  call(method: Method, url: string, payload?: unknown): Promise<ApiAnswer> {
    const headers = method === 'GET' ? { ...this.session.headers } : { ...this.session.mutationHeaders };
    return this.send(method, url, headers, payload);
  }

  /** Sends a mutation with the session cookie but without the CSRF token (what a forged cross-site request looks like). */
  withoutCsrf(method: Exclude<Method, 'GET'>, url: string, payload?: unknown): Promise<ApiAnswer> {
    return this.send(method, url, { ...this.session.headers }, payload);
  }

  /** Sends a request that carries no session at all (a signed-out console). */
  anonymous(method: Method, url: string, payload?: unknown): Promise<ApiAnswer> {
    return this.send(method, url, {}, payload);
  }

  private async send(
    method: Method,
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ): Promise<ApiAnswer> {
    headers.origin = CONSOLE_ORIGIN;
    const res = await this.t.app.inject({
      method,
      url,
      headers,
      remoteAddress: this.ip,
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
    const text = res.body;
    const total = Number(res.headers['x-total-count'] ?? Number.NaN);
    return { body: text === '' ? undefined : JSON.parse(text), status: res.statusCode, res, total };
  }

  get = (url: string) => this.call('GET', url);
  post = (url: string, payload?: unknown) => this.call('POST', url, payload);
  patch = (url: string, payload?: unknown) => this.call('PATCH', url, payload);
  put = (url: string, payload?: unknown) => this.call('PUT', url, payload);
  delete = (url: string) => this.call('DELETE', url);
}

/**
 * Creates a role, a staff member and a full session, and returns the client for that member.
 *
 * @param t the running test app
 * @param permissions the permissions of the member's new role (`['*']` makes an Owner)
 * @param options the member's name and the address the requests come from
 * @returns the client with the ids
 */
export async function adminWith(
  t: TestApp,
  permissions: string[],
  options: { readonly name?: string; readonly ip?: string; readonly roleName?: string } = {},
): Promise<AdminApi> {
  const { db } = await testDb();
  const roleId = await insertRole(db, permissions, options.roleName);
  const staffId = await insertStaff(db, roleId, { ...(options.name === undefined ? {} : { name: options.name }) });
  const session = await openSession(t, { type: 'staff', id: staffId });
  return new AdminApi(t, session, staffId, roleId, options.ip);
}

/** Signs an existing staff member in with a full session (no password or code: the session service makes it). */
export async function adminFor(t: TestApp, staffId: number, roleId: number, ip?: string): Promise<AdminApi> {
  const session = await openSession(t, { type: 'staff', id: staffId });
  return new AdminApi(t, session, staffId, roleId, ip);
}
