// MerchantSessionsService: the use cases of GET /client/sessions and DELETE /client/sessions/:id (map domain A, stage 2;
// MISMATCHES B135, B136): the merchant's own signed-in devices.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import type { Session } from '../db/schema';
import {
  type ClientSessionSortField,
  findLiveClientSession,
  listLiveClientSessions,
} from '../infra/merchant-sessions.repository';
import type { MerchantPrincipal } from '../security/principal';
import { SessionPolicy } from '../security/session-policy';
import { SessionService } from '../security/session.service';

/** One live session as the portal shows it (never the token). */
export interface MerchantSessionRow {
  readonly id: number;
  readonly ip: string;
  readonly userAgent: string;
  readonly lastSeenAt: Date;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** True for the session that made this request. */
  readonly current: boolean;
}

/** The range and sort of a list request, already parsed and checked by the contract. */
export interface MerchantSessionListRequest {
  readonly offset: number;
  readonly limit: number;
  readonly sort: readonly { readonly field: ClientSessionSortField; readonly order: 'asc' | 'desc' }[];
}

/**
 * Lists and ends a merchant's live sessions.
 *
 * Why: B135/B136 with the one "live session" rule of identity-platform-6: not revoked, not past its end, and not idle for
 * longer than `sessions.client_idle_minutes`. A session that is not the caller's, unknown or no longer live is `404`, all the
 * same, so a merchant cannot probe other people's session ids.
 *
 * Side effects: `end` sets `sessions.revoked_at` and drops the cached view after the commit.
 *
 * @see docs/contract/MISMATCHES.md (B135, B136)
 */
@Injectable()
export class MerchantSessionsService {
  constructor(
    private readonly db: DbService,
    private readonly sessions: SessionService,
    private readonly policy: SessionPolicy,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists the merchant's live sessions, newest first by default.
   *
   * @param principal the signed-in merchant
   * @param request the range and the sort keys
   * @returns the rows in the range and the exact total
   */
  async list(
    principal: MerchantPrincipal,
    request: MerchantSessionListRequest,
  ): Promise<{ rows: MerchantSessionRow[]; total: number }> {
    const { idleMs } = await this.policy.limits('client');
    const page = await listLiveClientSessions(this.db.db, principal.clientId, this.clock.now(), idleMs, request);
    return {
      rows: page.rows.map((row) => rowOf(row, row.id === principal.session.id)),
      total: page.total,
    };
  }

  /**
   * Ends one of the merchant's sessions.
   *
   * @param principal the signed-in merchant
   * @param sessionId the session to end
   * @returns `current`: true when the caller ended its own session (the controller then clears the cookies)
   * @throws {AppError} `NOT_FOUND` (404): not the caller's session, unknown, or no longer live
   */
  async end(principal: MerchantPrincipal, sessionId: number): Promise<{ readonly current: boolean }> {
    const { idleMs } = await this.policy.limits('client');
    await this.db.runInTransaction(async (work) => {
      const found = await findLiveClientSession(work.tx, principal.clientId, sessionId, this.clock.now(), idleMs);
      // Revoked by someone else between the two statements reads as already ended.
      if (!found || !(await this.sessions.revoke(found.id, work))) throw new AppError('NOT_FOUND');
    });
    return { current: sessionId === principal.session.id };
  }
}

function rowOf(row: Session, current: boolean): MerchantSessionRow {
  return {
    id: row.id,
    ip: row.ip,
    userAgent: row.userAgent,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    current,
  };
}
