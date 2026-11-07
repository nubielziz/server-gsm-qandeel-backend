// SessionService: create, rotate, touch, revoke and look up the sessions of staff, merchants and customers (decision 018).
// Tokens are random and stored only as keyed hashes (decision 019); lookups are cached 60 seconds in the cache Redis and
// deleted after the commit of any change to the session or its account.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { CacheKeys, CacheService } from '../../../infra/cache';
import { TokenService } from '../../../infra/crypto';
import { DbService, type DbExecutor, type TransactionContext } from '../../../infra/db';
import type { SubjectType } from '../db/schema';
import { SessionPolicy } from './session-policy';
import {
  findLiveSessionByHash,
  insertSession,
  liveTokenHashesOf,
  revokeLiveSession,
  revokeLiveSessionsOf,
  touchSession,
} from './session.repository';
import { SessionSubjects } from './subject-resolvers';
import type { CreateSessionInput, IssuedSession, RotateSessionInput, SessionView } from './session.types';

/**
 * The transaction a caller already has: the session change joins it, and the cache is cleaned after its commit.
 *
 * Why: a staff suspension revokes sessions in the same transaction as the status change (decision 022: invalidate after
 * the commit). Without it the service opens a transaction of its own.
 */
export type SessionWork = Pick<TransactionContext, 'tx' | 'afterCommit'>;

/** `last_seen_at` is written at most this often (decision 018). */
export const TOUCH_INTERVAL_MS = 60_000;
/** How long a session lookup stays in the cache (decision 018). */
export const SESSION_CACHE_TTL_SECONDS = 60;
/** How long "no live session for this token" stays in the cache, so a flood of bad tokens does not reach Postgres. */
export const UNKNOWN_SESSION_TTL_SECONDS = 10;

/** 32 random bytes in base64url are 43 characters; anything else cannot be one of our tokens. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_USER_AGENT = 512;
const MAX_TTL_SECONDS = 400 * 24 * 60 * 60;

function assertCreateInput(input: CreateSessionInput): void {
  if (!Number.isSafeInteger(input.subjectId) || input.subjectId < 1) {
    throw new RangeError(`A session needs a subject id from 1, got ${input.subjectId}`);
  }
  if (input.ip.trim() === '') throw new RangeError('A session needs the IP of the sign-in request');
  if (
    input.ttlSeconds !== undefined &&
    (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > MAX_TTL_SECONDS)
  ) {
    throw new RangeError(`A session lifetime must be 1 to ${MAX_TTL_SECONDS} seconds, got ${input.ttlSeconds}`);
  }
}

/**
 * The session store behind the cookies.
 *
 * Why: decision 018 uses one session mechanism for staff, merchants and customers: an opaque 256-bit token in a cookie,
 * a row in `sessions` with a sign-in stage, absolute and idle expiry from settings, rotation when a step completes
 * (no fixation) and revocation of one session or all sessions of an account.
 *
 * Side effects: reads and writes `sessions`; reads and deletes `gsm:{env}:identity:session:{tokenHash}` in the cache Redis.
 *
 * @see docs/decisions/018-auth-sessions-csrf.md and docs/cache-keys.md
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
    private readonly tokens: TokenService,
    private readonly policy: SessionPolicy,
    private readonly subjects: SessionSubjects,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Creates a session and returns its token.
   *
   * Why: login creates a pending session (10 minutes) and the sign-in steps rotate it to `active`; merchant and customer
   * sign-in create their sessions directly.
   *
   * Side effects: inserts a `sessions` row (the token hash only).
   *
   * @param input subject, stage, IP, user agent and an optional lifetime
   * @param work the caller's transaction, if it has one
   * @returns the token (for the cookie; it exists nowhere else) and the stored row
   * @throws {RangeError} when the subject id, the IP or the lifetime is not valid
   */
  create(input: CreateSessionInput, work?: SessionWork): Promise<IssuedSession> {
    assertCreateInput(input);
    return this.within(work, ({ tx }) => this.insert(tx, input, this.clock.now()));
  }

  /**
   * Replaces a session by a new one for the same account: new token, the old one revoked.
   *
   * Why: decision 018: reaching `active` rotates the token, so a token known before the last sign-in step is worthless
   * (session fixation). The CSRF token changes with it.
   *
   * Side effects: revokes the old row and inserts the new one in one transaction; deletes the old cache key after the commit.
   *
   * @param current the session being replaced (`principal.session`)
   * @param input the new stage and, optionally, IP, user agent and lifetime
   * @param work the caller's transaction, if it has one
   * @returns the new token and row
   * @throws {AppError} `UNAUTHORIZED` (401) when the old session was revoked or ended in the meantime
   */
  rotate(current: Pick<SessionView, 'id'>, input: RotateSessionInput, work?: SessionWork): Promise<IssuedSession> {
    return this.within(work, async (context) => {
      const now = this.clock.now();
      const old = await revokeLiveSession(context.tx, current.id, now);
      // An ended session cannot be carried forward; throwing rolls the revoke back with the transaction.
      if (!old || old.expiresAt.getTime() <= now.getTime()) throw new AppError('UNAUTHORIZED');
      const create: CreateSessionInput = {
        subjectType: old.subjectType,
        subjectId: old.subjectId,
        stage: input.stage,
        ip: input.ip ?? old.ip,
        userAgent: input.userAgent ?? old.userAgent,
        ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
      };
      assertCreateInput(create);
      const issued = await this.insert(context.tx, create, now);
      this.forgetAfterCommit(context, [old.tokenHash]);
      return issued;
    });
  }

  /**
   * Finds the live session behind a cookie token.
   *
   * Why: every authenticated request starts here; the answer is cached 60 seconds (a token that matches nothing 10 seconds).
   * The result can be up to a minute old, so the caller judges expiry with `livenessOf` on every request.
   *
   * @param token the value of the session cookie
   * @returns the session view, or `undefined` for an unknown, revoked or ended session, an account that is gone, or a token
   *   that cannot be one of ours
   */
  async lookup(token: string): Promise<SessionView | undefined> {
    if (!TOKEN_SHAPE.test(token)) return undefined;
    const hash = this.tokens.hash(token);
    const view = await this.cache.getOrLoad(this.keys.session(hash), SESSION_CACHE_TTL_SECONDS, () => this.load(hash), {
      negativeTtlSeconds: UNKNOWN_SESSION_TTL_SECONDS,
    });
    // A cached "nothing" comes back as null.
    return view ?? undefined;
  }

  /**
   * Writes `last_seen_at`, at most once a minute.
   *
   * Why: decision 018 measures idleness with it; writing on every request would turn every read into a write.
   *
   * Side effects: updates `sessions.last_seen_at` and deletes the cached view, so the next lookup sees the new time. The view
   * is dropped even when another instance wrote first: it carries an old time either way, and keeping it would repeat the
   * failed write on every request until the entry expires.
   *
   * @param view the session as the guard saw it
   * @param nowMs the current time in milliseconds; default the injected clock's (decision 031)
   * @returns true when this call wrote the row
   */
  async touch(view: SessionView, nowMs: number = this.clock.nowMs()): Promise<boolean> {
    if (nowMs - view.lastSeenAtMs < TOUCH_INTERVAL_MS) return false;
    const written = await touchSession(this.db.db, view.id, new Date(nowMs), TOUCH_INTERVAL_MS);
    await this.cache.del(this.keys.session(view.tokenHash));
    return written;
  }

  /**
   * Ends one session.
   *
   * Why: logout, "end this device" and the admin's revoke-session route.
   *
   * Side effects: sets `revoked_at`; deletes the cached view after the commit.
   *
   * @param sessionId the session id
   * @param work the caller's transaction, if it has one
   * @returns true when the session was live and is now revoked, false when it was already ended
   */
  revoke(sessionId: number, work?: SessionWork): Promise<boolean> {
    return this.within(work, async (context) => {
      const row = await revokeLiveSession(context.tx, sessionId, this.clock.now());
      if (row) this.forgetAfterCommit(context, [row.tokenHash]);
      return row !== undefined;
    });
  }

  /**
   * Ends every live session of an account, optionally keeping one.
   *
   * Why: suspension, password change and reset, "end all sessions" and the 2FA reset sign the account out everywhere
   * (decision 018); a password change keeps the caller's own session.
   *
   * Side effects: sets `revoked_at` on every live session of the account; deletes their cached views after the commit.
   *
   * @param subjectType staff, client or customer
   * @param subjectId the account id
   * @param options `exceptSessionId`: a session to keep
   * @param work the caller's transaction, if it has one
   * @returns how many sessions were revoked
   */
  revokeAllOf(
    subjectType: SubjectType,
    subjectId: number,
    options: { readonly exceptSessionId?: number } = {},
    work?: SessionWork,
  ): Promise<number> {
    return this.within(work, async (context) => {
      const rows = await revokeLiveSessionsOf(
        context.tx,
        subjectType,
        subjectId,
        this.clock.now(),
        options.exceptSessionId,
      );
      this.forgetAfterCommit(
        context,
        rows.map((row) => row.tokenHash),
      );
      return rows.length;
    });
  }

  /**
   * Drops the cached views of an account's sessions without ending them.
   *
   * Why: the cached view holds the account state (status, role id), so a change to the account (suspension, role change,
   * password change) must delete it, or the old state would be served for up to a minute (decision 018).
   *
   * Side effects: deletes the cache keys of the account's live sessions (after the commit when `work` is given).
   *
   * @param subjectType staff, client or customer
   * @param subjectId the account id
   * @param work the caller's transaction, if it has one
   */
  async invalidateSubject(subjectType: SubjectType, subjectId: number, work?: SessionWork): Promise<void> {
    const hashes = await liveTokenHashesOf(work?.tx ?? this.db.db, subjectType, subjectId);
    if (work) this.forgetAfterCommit(work, hashes);
    else await this.forget(hashes);
  }

  private async load(hash: string): Promise<SessionView | undefined> {
    const row = await findLiveSessionByHash(this.db.db, hash, this.clock.now());
    if (!row) return undefined;
    const subject = await this.subjects.resolve(row.subjectType, row.subjectId);
    if (subject.state === 'gone') return undefined;
    return {
      id: row.id,
      tokenHash: row.tokenHash,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      stage: row.stage,
      ip: row.ip,
      userAgent: row.userAgent,
      lastSeenAtMs: row.lastSeenAt.getTime(),
      expiresAtMs: row.expiresAt.getTime(),
      idleMs: await this.policy.idleMs(row.subjectType, row.stage),
      subject,
    };
  }

  private async insert(tx: DbExecutor, input: CreateSessionInput, now: Date): Promise<IssuedSession> {
    const token = this.tokens.random(32);
    const ttlMs =
      input.ttlSeconds !== undefined
        ? input.ttlSeconds * 1000
        : await this.policy.lifetimeMs(input.subjectType, input.stage);
    const session = await insertSession(tx, {
      tokenHash: this.tokens.hash(token),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      stage: input.stage,
      ip: input.ip,
      userAgent: (input.userAgent ?? '').slice(0, MAX_USER_AGENT),
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      // The sessions list shows it: written from the clock like the two times above, not from the column default (decision 031).
      createdAt: now,
    });
    return { token, session };
  }

  private within<T>(work: SessionWork | undefined, fn: (context: SessionWork) => Promise<T>): Promise<T> {
    return work ? fn(work) : this.db.runInTransaction((context) => fn(context));
  }

  private forgetAfterCommit(context: Pick<SessionWork, 'afterCommit'>, hashes: readonly string[]): void {
    if (hashes.length === 0) return;
    context.afterCommit(() => this.forget(hashes));
  }

  private async forget(hashes: readonly string[]): Promise<void> {
    if (hashes.length > 0) await this.cache.del(...hashes.map((hash) => this.keys.session(hash)));
  }
}
