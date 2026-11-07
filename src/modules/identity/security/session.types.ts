// Types and pure rules of the session service (decision 018): the cached view of a session, what creating one takes, and
// when a session counts as ended. No I/O here, so the rules are unit-tested.
import type { Session, SessionStage, SubjectType } from '../db/schema';

/**
 * What the session guards need to know about the account behind a session.
 *
 * Why: a suspended account must be refused with `403 ACCOUNT_SUSPENDED` and an account that no longer exists with `401`;
 * every subject type (staff, merchant, customer) maps its own statuses onto these three states (decision 018: "their tables
 * and statuses").
 */
export type SubjectState = 'ok' | 'suspended' | 'gone';

/**
 * The account state a session depends on, read when the session is loaded.
 *
 * Why: it is cached with the session for 60 seconds, so a request costs one cache read. `roleId` is set for staff. `name`
 * is the account's display name: the audit log snapshots it as the actor (RESOLUTIONS identity-platform-7), so a rename must
 * call `SessionService.invalidateSubject`.
 */
export interface SubjectSnapshot {
  readonly state: SubjectState;
  readonly roleId?: number;
  readonly name?: string;
  /**
   * Merchants only: true when the merchant is approved (`clients.status = 'active'`). A merchant waiting for approval
   * (`pending`) keeps a session but may call only the routes that declare `pendingMerchant: 'allow'` (B153). A view cached
   * without the field counts as not approved, so the guard fails closed for at most the cache lifetime.
   */
  readonly approved?: boolean;
}

/**
 * A live session as the guards see it (and as the cache holds it: plain JSON, times in milliseconds).
 *
 * Why: decision 018 caches a session lookup for 60 seconds in the cache Redis and deletes it on revoke, suspend, password
 * change and role change. The view carries the account state and the idle limit that applied when it was loaded.
 */
export interface SessionView {
  readonly id: number;
  /** HMAC of the session token (decision 019); the CSRF token is derived from it. */
  readonly tokenHash: string;
  readonly subjectType: SubjectType;
  readonly subjectId: number;
  readonly stage: SessionStage;
  readonly ip: string;
  readonly userAgent: string;
  /** When the session was last used, as last written to the database (at most once a minute). */
  readonly lastSeenAtMs: number;
  /** The absolute end of the session. */
  readonly expiresAtMs: number;
  /** How long a full session may sit unused before it ends; `0` for a pending stage (its short absolute limit applies). */
  readonly idleMs: number;
  readonly subject: SubjectSnapshot;
}

/** Why a session is (or is not) still usable. */
export type Liveness = 'live' | 'expired' | 'idle';

/**
 * Decides whether a session is still usable at a moment.
 *
 * Why: decision 018: absolute expiry for every stage, plus an idle expiry for full sessions (staff 30 minutes, merchants and
 * customers 7 days). The cached view can be up to a minute old, so the guards judge it again on every request.
 *
 * @param view the session
 * @param nowMs the current time in milliseconds
 * @returns `expired` after the absolute end, `idle` after too long without use, otherwise `live`
 */
export function livenessOf(
  view: Pick<SessionView, 'expiresAtMs' | 'lastSeenAtMs' | 'idleMs'>,
  nowMs: number,
): Liveness {
  if (nowMs >= view.expiresAtMs) return 'expired';
  if (view.idleMs > 0 && nowMs - view.lastSeenAtMs > view.idleMs) return 'idle';
  return 'live';
}

/**
 * The input of {@link SessionService.create}.
 *
 * Why: the sign-in routes create sessions for the three subject types with the stage they have reached.
 */
export interface CreateSessionInput {
  readonly subjectType: SubjectType;
  readonly subjectId: number;
  readonly stage: SessionStage;
  /** The client IP of the sign-in request. */
  readonly ip: string;
  readonly userAgent?: string;
  /** Seconds the session lives; by default the lifetime setting of the subject and stage (pending stages: 10 minutes). */
  readonly ttlSeconds?: number;
}

/**
 * The input of {@link SessionService.rotate}: what changes in the new session.
 *
 * Why: reaching `active` rotates the token (no fixation, decision 018); the subject stays, the stage and lifetime change.
 */
export interface RotateSessionInput {
  readonly stage: SessionStage;
  /** The IP of the request that rotates; defaults to the old session's. */
  readonly ip?: string;
  readonly userAgent?: string;
  readonly ttlSeconds?: number;
}

/**
 * A freshly created session and its token.
 *
 * Why: the token exists only here, in clear text, once: the caller puts it in the cookie and drops it. The database holds
 * only the keyed hash (decision 019).
 */
export interface IssuedSession {
  /** The token for the cookie. Never log it, never store it. */
  readonly token: string;
  readonly session: Session;
}
