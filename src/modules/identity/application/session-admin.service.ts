// SessionAdminService: the use cases of the admin session routes (map domain A, stage 2): the live sessions of staff and
// merchants, and ending one of them.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import { type SessionWithSubject, findListedSession, listLiveSessions } from '../infra/session-admin.repository';
import type { StaffPrincipal } from '../security/principal';
import type { IdleLimits } from '../security/session.repository';
import { SessionPolicy } from '../security/session-policy';
import { idleLimitsOf } from './idle-limits';
import { SessionService } from '../security/session.service';

/** A session as the console lists it. */
export interface SessionRowView {
  readonly id: number;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly ip: string;
  readonly userAgent: string;
  readonly lastSeenAt: string | null;
  readonly subjectType: 'staff' | 'client';
  readonly subject: { id: number; name: string; email?: string };
  readonly current: boolean;
}

/**
 * Lists and ends sessions for staff.
 *
 * Why: scenario admin-team and ip-rules, RESOLUTIONS identity-platform-6: "active" is one rule everywhere (not revoked, not
 * past its end, used within the idle limit). The list shows fully signed-in staff and merchant sessions only (B9).
 *
 * Side effects: `remove` sets `revoked_at`, deletes the cached session view after the commit and writes `audit_logs`.
 *
 * @see docs/contract/endpoints/identity.md (GET /admin/sessions, DELETE /admin/sessions/:id)
 */
@Injectable()
export class SessionAdminService {
  constructor(
    private readonly db: DbService,
    private readonly sessions: SessionService,
    private readonly policy: SessionPolicy,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists the live sessions.
   *
   * @param caller the signed-in staff member (their own session is marked `current`)
   * @param query the parsed list request
   * @returns the page of sessions and the exact total
   */
  async list(
    caller: StaffPrincipal,
    query: ParsedListQuery<'lastSeenAt' | 'createdAt' | 'id'>,
  ): Promise<{ rows: SessionRowView[]; total: number }> {
    const { rows, total } = await listLiveSessions(this.db.db, query, this.clock.now(), await this.idleLimits());
    return { rows: rows.map((row) => toView(row, caller.session.id)), total };
  }

  /**
   * Ends a live session.
   *
   * @param caller the signed-in staff member
   * @param id the session id
   * @throws {AppError} `NOT_FOUND` (404) when the session is unknown or no longer live by the list's rule
   */
  async remove(caller: StaffPrincipal, id: number): Promise<void> {
    const idle = await this.idleLimits();
    await this.db.runInTransaction(async (work) => {
      const found = await findListedSession(work.tx, id, this.clock.now(), idle);
      if (!found) throw new AppError('NOT_FOUND', { detail: 'No live session has this id.' });
      // False only when a parallel request ended it first: the end state is the one asked for.
      await this.sessions.revoke(id, work);
      await this.audit.record(work.tx, {
        action: 'ended session of',
        entityType: 'session',
        entityId: id,
        entityLabel: found.subjectName ?? `${found.session.subjectType} ${found.session.subjectId}`,
        before: { subjectType: found.session.subjectType, subjectId: found.session.subjectId, ip: found.session.ip },
        after: { ended: true, own: id === caller.session.id },
      });
    });
  }

  private idleLimits(): Promise<IdleLimits> {
    return idleLimitsOf(this.policy);
  }
}

function toView({ session, subjectName, subjectEmail }: SessionWithSubject, currentId: number): SessionRowView {
  return {
    id: session.id,
    expiresAt: session.expiresAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    ip: session.ip,
    userAgent: session.userAgent,
    lastSeenAt: session.lastSeenAt.toISOString(),
    subjectType: session.subjectType === 'client' ? 'client' : 'staff',
    subject: {
      id: session.subjectId,
      name: subjectName ?? '',
      ...(subjectEmail === null ? {} : { email: subjectEmail }),
    },
    current: session.id === currentId,
  };
}
