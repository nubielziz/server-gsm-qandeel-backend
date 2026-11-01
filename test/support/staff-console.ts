// A stand-in for the admin console in tests: it keeps the cookies and the CSRF token the way a browser and the console's API
// client do, sends the Origin header, and offers the staff accounts and TOTP codes the sign-in tests need.
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { generate } from 'otplib';
import { PasswordHasher } from '../../src/infra/crypto';
import { type StaffUser } from '../../src/modules/identity/db/schema';
import { TotpService } from '../../src/modules/identity/application/totp.service';
import { schema as s } from '../../src/infra/db';
import { type TestApp } from './app';
import { insertRole } from './auth';
import { testDb } from './db';

/** The origin the test app lists in `CORS_ORIGINS`. */
export const CONSOLE_ORIGIN = 'https://console.example.com';
/** The password of every staff member `makeStaff` creates unless told otherwise. */
export const PASSWORD = 'correct-horse-battery';

/** One call of the console: what to send besides the cookies. */
export interface CallOptions {
  /** Send the Origin header (default true, like a browser calling from the console). */
  readonly origin?: boolean | string;
  /** Send `X-CSRF-Token`: the remembered token (default for mutations), a given text, or false to omit it. */
  readonly csrf?: boolean | string;
  /** Send the session cookie (default true). */
  readonly cookies?: boolean;
}

/** A browser plus the console's API client, talking to the test app by `inject`. */
export class StaffConsole {
  private readonly jar = new Map<string, string>();
  /** The last CSRF token the API sent (header or cookie), as the console remembers it. */
  csrf: string | undefined;

  constructor(
    private readonly t: TestApp,
    private readonly ip = '127.0.0.1',
  ) {}

  /** The value of a cookie in the jar. */
  cookie(name: string): string | undefined {
    return this.jar.get(name);
  }

  /** The staff session token in the jar. */
  get sessionToken(): string | undefined {
    return this.jar.get('gsm_admin_session');
  }

  /** Puts a session token in the jar, as a browser that kept an old cookie would. */
  setSessionToken(token: string): void {
    this.jar.set('gsm_admin_session', token);
  }

  /** Sends a request the way the console does and absorbs the cookies and the CSRF header of the answer. */
  async call(
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    options: CallOptions = {},
  ): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {};
    const origin = options.origin ?? true;
    if (origin) headers.origin = origin === true ? CONSOLE_ORIGIN : origin;
    if ((options.cookies ?? true) && this.jar.size > 0) {
      headers.cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    const csrf = options.csrf ?? method !== 'GET';
    if (typeof csrf === 'string') headers['x-csrf-token'] = csrf;
    else if (csrf && this.csrf !== undefined) headers['x-csrf-token'] = this.csrf;
    const res = await this.t.app.inject({
      method,
      url,
      headers,
      remoteAddress: this.ip,
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
    for (const cookie of res.cookies) {
      if (cookie.value === '' || cookie.maxAge === 0) this.jar.delete(cookie.name);
      else this.jar.set(cookie.name, cookie.value);
    }
    const header = res.headers['x-csrf-token'];
    if (typeof header === 'string') this.csrf = header;
    return res;
  }

  /** `POST /admin/auth/login`. */
  login(email: string, password: string = PASSWORD, options?: CallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/admin/auth/login', { email, password }, options);
  }

  /** `POST /admin/auth/2fa`. */
  code(code: string, options?: CallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/admin/auth/2fa', { code }, options);
  }

  /** `POST /admin/auth/2fa/setup`. */
  setup(options?: CallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/admin/auth/2fa/setup', undefined, options);
  }

  /** `GET /admin/auth/me`. */
  me(options?: CallOptions): Promise<LightMyRequestResponse> {
    return this.call('GET', '/admin/auth/me', undefined, options);
  }

  /** `POST /admin/auth/logout`. */
  logout(options?: CallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/admin/auth/logout', undefined, options);
  }

  /** `POST /admin/auth/password/set`. */
  setPassword(body: { token?: string; password: string }, options?: CallOptions): Promise<LightMyRequestResponse> {
    return this.call('POST', '/admin/auth/password/set', body, options);
  }
}

/** What `makeStaff` creates. */
export interface MadeStaff {
  readonly id: number;
  readonly email: string;
  /** The base32 secret of the account's authenticator (also stored, encrypted, when 2FA is on or pending). */
  readonly secret: string;
  readonly row: StaffUser;
}

/** What a test can change about the staff member `makeStaff` creates. */
export type StaffOverrides = Partial<typeof s.staffUsers.$inferInsert> & {
  /** Store no password hash (an account invited by link). */
  readonly noPassword?: boolean;
  /** The password to hash (default {@link PASSWORD}). */
  readonly password?: string;
  /** Store no TOTP secret (an account that has not set 2FA up). */
  readonly noSecret?: boolean;
  /** Permissions of the new role (default one that the tests can read back). */
  readonly permissions?: string[];
};

/** Creates an active staff member with a password and 2FA on, unless told otherwise. */
export async function makeStaff(t: TestApp, overrides: StaffOverrides = {}): Promise<MadeStaff> {
  const { db } = await testDb();
  const { noPassword, noSecret, password, permissions, ...columns } = overrides;
  const roleId = await insertRole(db, permissions ?? ['orders:read', 'staff:*']);
  const totp = t.app.get(TotpService);
  const secret = totp.newSecret();
  const email = `staff-${randomUUID()}@example.com`;
  const [row] = await db
    .insert(s.staffUsers)
    .values({
      email,
      name: 'Test Staff',
      roleId,
      status: 'active',
      twofaEnabled: true,
      passwordHash: noPassword ? null : await t.app.get(PasswordHasher).hash(password ?? PASSWORD),
      totpSecretEnc: noSecret ? null : totp.seal(secret),
      ...columns,
    })
    .returning();
  return { id: row!.id, email: row!.email, secret, row: row! };
}

/**
 * The six-digit code of a secret at a moment, as an authenticator app shows it.
 *
 * @param secret the base32 secret
 * @param atMs the moment in epoch milliseconds: the app's test clock (`clock.nowMs()`), plus whole 30 s steps for codes of
 *   another step (decision 031)
 * @returns the code
 */
export function codeFor(secret: string, atMs: number): Promise<string> {
  return generate({ secret, epoch: atMs / 1000 });
}
