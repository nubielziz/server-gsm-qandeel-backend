// SessionService: create, rotate, touch, revoke and look up the sessions of staff and accounts (decision 018, decision 064).
// Tokens are random and stored only as keyed hashes (decision 019); lookups are cached 60 seconds in the cache Redis and
// deleted after the commit of any change to the session or its account, which also rings the `session` doorbell (decision 037).
// A cached view is used only when it belongs to the presented token, and its deletes are retried (decision 055).
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { LogThrottle } from '../../../common/log-throttle';
import { CacheKeys, CacheService } from '../../../infra/cache';
import { TokenService } from '../../../infra/crypto';
import { DbService, type DbExecutor, type Transaction, type TransactionContext, onCommit } from '../../../infra/db';
import { RATE_LIMITERS } from '../../../infra/rate-limit';
import { RealtimePublisher, SESSION_TOPIC } from '../../../infra/realtime';
import type { SubjectType } from '../db/schema';
import { AccountSessions, type AccountSessionStart } from '../ports/account-sessions';
import { SessionCookies } from './session-cookies';
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
/**
 * A cached session view read with less than this many seconds of freshness left is loaded again in the background.
 *
 * Why: decision 053. While an address has used up its budget of failed lookups, only sessions whose view is in the cache are answered;
 * with {@link SESSION_CACHE_GRACE_SECONDS}, a session used at least every 90 seconds (this plus the grace) stays answered there.
 */
export const SESSION_CACHE_REFRESH_AHEAD_SECONDS = 30;
/**
 * How long a session view stays in the cache after its freshness for the cache-only lookup ({@link SessionService.lookupCached}):
 * one window of the failed-lookup budget (the `ip` limiter).
 *
 * Why: decision 053. A view is fresh for 60 s +-15 % (51 s at least), shorter than the budget window, so a session used once a minute
 * would drop out of the cache between two requests. The normal lookup still reads the database once the view is no longer fresh.
 */
export const SESSION_CACHE_GRACE_SECONDS = RATE_LIMITERS.ip.windowSeconds;
/** The cache options of a session view. */
const VIEW_CACHE = {
  negativeTtlSeconds: UNKNOWN_SESSION_TTL_SECONDS,
  refreshAheadSeconds: SESSION_CACHE_REFRESH_AHEAD_SECONDS,
  cachedOnlyGraceSeconds: SESSION_CACHE_GRACE_SECONDS,
} as const;

/** 32 random bytes in base64url are 43 characters; anything else cannot be one of our tokens. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_USER_AGENT = 512;
const MAX_TTL_SECONDS = 400 * 24 * 60 * 60;
/** Session ids per `session ended` doorbell: well under its 8 KB. */
const ENDED_IDS_PER_DOORBELL = 500;

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
 * Why: decision 018 uses one session mechanism for staff and accounts: an opaque 256-bit token in a cookie,
 * a row in `sessions` with a sign-in stage, absolute and idle expiry from settings, rotation when a step completes
 * (no fixation) and revocation of one session or all sessions of an account. It is also the implementation of the
 * {@link AccountSessions} port (decision 064): the sign-in use cases start and end the sessions of accounts through it.
 *
 * Side effects: reads and writes `sessions`; reads and deletes `gsm:{env}:identity:session:{tokenHash}` in the cache Redis (the
 * deletes after the commit, retried and reported when Redis fails, decision 055); after the commit of an end (revoke, rotate, revoke
 * all) rings `session ended` with the session ids, and after an account change (`invalidateSubject`) `session subject`, so the live
 * streams of those sessions close (decision 037).
 *
 * @see docs/decisions/018-auth-sessions-csrf.md, docs/decisions/055-infra.md and docs/cache-keys.md
 */
@Injectable()
export class SessionService implements AccountSessions {
  private readonly logger = new Logger(SessionService.name);
  private readonly throttle = new LogThrottle(60_000);

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
    private readonly tokens: TokenService,
    private readonly policy: SessionPolicy,
    private readonly subjects: SessionSubjects,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly realtime: RealtimePublisher,
    private readonly cookies: SessionCookies,
  ) {}

  /**
   * Creates a session and returns its token.
   *
   * Why: login creates a pending session (10 minutes) and the sign-in steps rotate it to `active`; an account's sign-in creates its
   * session directly (through {@link SessionService.start}, which also sets the cookies).
   *
   * Side effects: inserts a `sessions` row (the token hash only); after the commit, loads its view into the cache (best effort;
   * decision 053: an address that used up its budget of failed lookups is answered from the cache only, so a new session is served
   * there from its first request).
   *
   * @param input subject, stage, IP, user agent and an optional lifetime
   * @param work the caller's transaction, if it has one
   * @returns the token (for the cookie; it exists nowhere else) and the stored row
   * @throws {RangeError} when the subject id, the IP or the lifetime is not valid
   */
  create(input: CreateSessionInput, work?: SessionWork): Promise<IssuedSession> {
    assertCreateInput(input);
    return this.within(work, async (context) => {
      const issued = await this.insert(context.tx, input, this.clock.now());
      this.cacheAfterCommit(context, issued.session.tokenHash);
      return issued;
    });
  }

  /**
   * Replaces a session by a new one for the same account: new token, the old one revoked.
   *
   * Why: decision 018: reaching `active` rotates the token, so a token known before the last sign-in step is worthless
   * (session fixation). The CSRF token changes with it.
   *
   * Side effects: revokes the old row and inserts the new one in one transaction; deletes the old cache key, rings `session
   * ended` for the old session and loads the view of the new one into the cache (best effort, as in {@link SessionService.create})
   * after the commit.
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
      this.announceEnded(context, [old.id]);
      this.cacheAfterCommit(context, issued.session.tokenHash);
      return issued;
    });
  }

  /**
   * Finds the live session behind a cookie token.
   *
   * Why: every authenticated request starts here; the answer is cached 60 seconds (a token that matches nothing 10 seconds).
   * The result can be up to a minute old, so the caller judges expiry with `livenessOf` on every request. The view is used only
   * when it belongs to the presented token (decision 055): a cached view whose token hash is another one is refused and deleted.
   *
   * Side effects: on a view that does not belong to the token, deletes its cache key (best effort) and logs one warning a minute; a
   * cached view with less than {@link SESSION_CACHE_REFRESH_AHEAD_SECONDS} left is loaded again in the background (decision 053).
   *
   * @param token the value of the session cookie
   * @returns the session view, or `undefined` for an unknown, revoked or ended session, an account that is gone, a token
   *   that cannot be one of ours, or a cached view of another token
   */
  lookup(token: string): Promise<SessionView | undefined> {
    return this.find(token, false);
  }

  /**
   * Finds the session behind a cookie token in the cache only, never in the database.
   *
   * Why: decision 053. An address that used up its budget of failed lookups costs no database read, and the sessions in use stay
   * served there: a view is answered while it is fresh and for {@link SESSION_CACHE_GRACE_SECONDS} after.
   *
   * Side effects: as {@link SessionService.lookup}, without the load on a miss; a view past its freshness is loaded again in the
   * background.
   *
   * @param token the value of the session cookie
   * @returns the cached session view, or `undefined` when the cache holds none for the token (or "nothing", or a view of another
   *   token)
   */
  lookupCached(token: string): Promise<SessionView | undefined> {
    return this.find(token, true);
  }

  /** The lookup of {@link SessionService.lookup}; `cachedOnly` answers from the cache alone. */
  private async find(token: string, cachedOnly: boolean): Promise<SessionView | undefined> {
    if (!TOKEN_SHAPE.test(token)) return undefined;
    const hash = this.tokens.hash(token);
    const key = this.keys.session(hash);
    const load = () => this.load(hash);
    const view = cachedOnly
      ? await this.cache.getIfCached(key, SESSION_CACHE_TTL_SECONDS, load, VIEW_CACHE)
      : await this.cache.getOrLoad(key, SESSION_CACHE_TTL_SECONDS, load, VIEW_CACHE);
    // A cached "nothing" comes back as null.
    if (!view) return undefined;
    if (!this.tokens.equals(view.tokenHash, hash)) {
      if (this.throttle.attempt('binding')) {
        this.logger.warn('A cached session view did not belong to the token it was stored for; it was ignored.');
      }
      await this.cache.del(key).catch(() => undefined);
      return undefined;
    }
    return view;
  }

  /**
   * Writes `last_seen_at`, at most once a minute.
   *
   * Why: decision 018 measures idleness with it; writing on every request would turn every read into a write.
   *
   * Side effects: updates `sessions.last_seen_at` and loads the cached view again from the database over the old one
   * ({@link CacheService.reload}), so the next lookup sees the new time and a session in use never leaves the cache, not even while the
   * view loads (decision 053: an address that used up its budget of failed lookups is answered from the cache only). The view is replaced
   * even when another instance wrote first: it carries an old time either way, and keeping it would repeat the failed write on every
   * request until the entry expires; a failed load deletes it.
   *
   * @param view the session as the guard saw it
   * @param nowMs the current time in milliseconds; default the injected clock's (decision 031)
   * @returns true when this call wrote the row
   */
  async touch(view: SessionView, nowMs: number = this.clock.nowMs()): Promise<boolean> {
    if (nowMs - view.lastSeenAtMs < TOUCH_INTERVAL_MS) return false;
    const written = await touchSession(this.db.db, view.id, new Date(nowMs), TOUCH_INTERVAL_MS);
    // Written over the old view, never deleted first, so a concurrent cache-only lookup still finds it. Best effort, like a lookup: a
    // failed load deletes the key and the next lookup loads it.
    await this.cache
      .reload(this.keys.session(view.tokenHash), SESSION_CACHE_TTL_SECONDS, () => this.load(view.tokenHash), VIEW_CACHE)
      .catch(() => undefined);
    return written;
  }

  /**
   * Ends one session.
   *
   * Why: logout, "end this device" and the admin's revoke-session route.
   *
   * Side effects: sets `revoked_at`; deletes the cached view and rings `session ended` after the commit.
   *
   * @param sessionId the session id
   * @param work the caller's transaction, if it has one
   * @returns true when the session was live and is now revoked, false when it was already ended
   */
  revoke(sessionId: number, work?: SessionWork): Promise<boolean> {
    return this.within(work, async (context) => {
      const row = await revokeLiveSession(context.tx, sessionId, this.clock.now());
      if (row) {
        this.forgetAfterCommit(context, [row.tokenHash]);
        this.announceEnded(context, [row.id]);
      }
      return row !== undefined;
    });
  }

  /**
   * Ends every live session of an account, optionally keeping one.
   *
   * Why: suspension, password change and reset, "end all sessions" and the 2FA reset sign the account out everywhere
   * (decision 018); a password change keeps the caller's own session.
   *
   * Side effects: sets `revoked_at` on every live session of the account; deletes their cached views and rings `session ended`
   * with their ids after the commit.
   *
   * @param subjectType staff or account
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
      this.announceEnded(
        context,
        rows.map((row) => row.id),
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
   * Side effects: deletes the cache keys of the account's live sessions (after the commit when `work` is given); when it has live
   * sessions, rings `session subject` afterwards, so its live streams end with `bye reauth` and reconnect through the guard.
   *
   * @param subjectType staff or account
   * @param subjectId the account id
   * @param work the caller's transaction, if it has one
   */
  async invalidateSubject(subjectType: SubjectType, subjectId: number, work?: SessionWork): Promise<void> {
    const hashes = await liveTokenHashesOf(work?.tx ?? this.db.db, subjectType, subjectId);
    if (work) this.forgetAfterCommit(work, hashes);
    else await this.forget(hashes);
    if (hashes.length === 0) return;
    // Inside an afterCommit callback the change is already committed: publish directly, since an onCommit() there would join
    // an enclosing transaction of the caller and be dropped by its rollback (the stream would then stay open until max_age).
    const fields = { subjectType, subjectId };
    if (work) work.afterCommit(() => void this.realtime.publish(SESSION_TOPIC, 'subject', fields));
    else this.realtime.publishOnCommit(SESSION_TOPIC, 'subject', fields);
  }

  /**
   * Opens the session of an account and sets its cookies on the reply (the `AccountSessions` port).
   *
   * Why: decision 064. Every sign-in (password, code step, link, forced change) ends in one session of subject `account`; the rank kind
   * (read by the caller under the account's lock) names the readable CSRF cookie that goes with it. The caller never touches the
   * cookies or the session store.
   *
   * Side effects: inserts a `sessions` row in the caller's transaction (see {@link SessionService.create}) and writes the session
   * cookie, the CSRF cookie of the rank kind, the clearing of the other CSRF name and of the old shop cookie, and the `X-CSRF-Token`
   * header on the reply, before the commit: the caller must send the reply only when the transaction commits.
   *
   * @param work the caller's transaction
   * @param reply the reply the cookies go on; the address and user agent of its request are stored with the session
   * @param input the account, the stage reached and the rank kind
   * @returns when the session ends
   * @throws {RangeError} when the account id or the address is not valid
   */
  async start(
    work: SessionWork,
    reply: FastifyReply,
    input: AccountSessionStart,
  ): Promise<{ readonly expiresAt: Date }> {
    const { ip, headers } = reply.request;
    const userAgent = headers['user-agent'];
    const issued = await this.create(
      {
        subjectType: 'account',
        subjectId: input.accountId,
        stage: input.stage,
        ip,
        ...(typeof userAgent === 'string' ? { userAgent } : {}),
      },
      work,
    );
    this.cookies.setAccount(reply, issued.token, issued.session.expiresAt, input.rankKind);
    return { expiresAt: issued.session.expiresAt };
  }

  /**
   * Ends every live session of an account inside the caller's transaction (the `AccountSessions` port).
   *
   * Why: a suspension, a rank change across kinds, a password reset and an erasure sign the account out everywhere (decision 064). The
   * caller holds only `tx`; the cache deletes and the `session ended` doorbell run after its commit through the transaction's own
   * callback list (`onCommit`), so a rolled-back change leaves the sessions and their views alone.
   *
   * Side effects: sets `revoked_at` on every live session; after the commit deletes their cached views and rings `session ended`.
   *
   * @param tx the caller's transaction
   * @param accountId the account
   * @returns how many sessions ended
   */
  async revokeAll(tx: Transaction, accountId: number): Promise<number> {
    const rows = await revokeLiveSessionsOf(tx, 'account', accountId, this.clock.now());
    const after = { afterCommit: onCommit };
    this.forgetAfterCommit(
      after,
      rows.map((row) => row.tokenHash),
    );
    this.announceEnded(
      after,
      rows.map((row) => row.id),
    );
    return rows.length;
  }

  /**
   * Drops the cached views of an account's sessions so the next request reads the stored state (the `AccountSessions` port).
   *
   * Why: a view holds the status and the rank of its account for up to a minute; after a change of either, the caller invalidates
   * after the commit (decision 064).
   *
   * Side effects: see {@link SessionService.invalidateSubject}.
   *
   * @param accountId the account
   * @returns when the cached views are dropped (and the live streams of the account told to read the session again)
   */
  invalidate(accountId: number): Promise<void> {
    return this.invalidateSubject('account', accountId);
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

  /** Loads the view of a new session into the cache after the commit; a failure only leaves the key empty (decision 053). */
  private cacheAfterCommit(context: Pick<SessionWork, 'afterCommit'>, hash: string): void {
    context.afterCommit(async () => {
      await this.cache
        .getOrLoad(this.keys.session(hash), SESSION_CACHE_TTL_SECONDS, () => this.load(hash), VIEW_CACHE)
        .catch(() => undefined);
    });
  }

  private forgetAfterCommit(context: Pick<SessionWork, 'afterCommit'>, hashes: readonly string[]): void {
    if (hashes.length === 0) return;
    context.afterCommit(() => this.forget(hashes));
  }

  /** Rings `session ended` after the commit (ids only), so the hub closes the live streams of those sessions (decision 037). */
  private announceEnded(context: Pick<SessionWork, 'afterCommit'>, ids: readonly number[]): void {
    if (ids.length === 0) return;
    context.afterCommit(() => {
      for (let at = 0; at < ids.length; at += ENDED_IDS_PER_DOORBELL) {
        // Already after the commit: publish directly (an onCommit() here would join an enclosing transaction, see above).
        void this.realtime.publish(SESSION_TOPIC, 'ended', {
          sessionIds: ids.slice(at, at + ENDED_IDS_PER_DOORBELL),
        });
      }
    });
  }

  /** Deletes the cached views; never throws: a failed delete is retried and reported by the cache (decision 055). */
  private async forget(hashes: readonly string[]): Promise<void> {
    if (hashes.length > 0) await this.cache.invalidate(...hashes.map((hash) => this.keys.session(hash)));
  }
}
