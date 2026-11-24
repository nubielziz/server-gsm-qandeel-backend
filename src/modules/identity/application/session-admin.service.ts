// SessionAdminService: the use cases of the admin session routes (map domain A, stage 2): the live sessions of staff and of accounts, and ending
// one of them.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { customerEmailIn } from '../../../common/customer-contact';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import { type SessionWithSubject, findListedSession, listLiveSessions } from '../infra/session-admin.repository';
import { findStaffRow } from '../infra/staff-admin.repository';
import { uncoveredPermissions } from '../security/permission-grammar';
import {
  assertOwnerTargetAllowed,
  assertWithinCeiling,
  customerContactOf,
  requirePermission,
} from '../security/principal';
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
  readonly subjectType: 'staff' | 'account';
  readonly subject: { id: number; name: string; email?: string };
  readonly current: boolean;
}

/** What the list shows in place of an address or a device that the caller may not read. */
const MASKED = '•••';

/** The permission that ends the session of an account (the same one every staff action on an account's access needs). */
const END_ACCOUNT_SESSION_PERMISSION = 'clients:security';

/**
 * Lists and ends sessions for staff.
 *
 * Why: scenario admin-team and ip-rules, RESOLUTIONS identity-platform-6: "active" is one rule everywhere (not revoked, not
 * past its end, used within the idle limit). The list shows fully signed-in sessions of staff and of accounts (decision 064: a merchant and a
 * retail account are one kind of subject, `account`); a sign-in step that is not finished is not listed. Decision 046: the list reads only what
 * the caller's permissions cover (the address and the device of another staff member's session are masked when that member's role holds
 * permissions the caller does not). Decision 047: an account's email is shown in full only to a caller who holds `clients:read`, for every rank.
 * Ending an account's session needs `clients:security` (a staff member's session needs only `sessions:revoke`, with the Owner rule) and is
 * audited under the account.
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
   * Lists the live staff and account sessions.
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
    return { rows: rows.map((row) => toView(row, caller)), total };
  }

  /**
   * Ends a live session of staff or of an account.
   *
   * @param caller the signed-in staff member
   * @param id the session id
   * @throws {AppError} `NOT_FOUND` (404) when the session is unknown or is no longer live by the list's rule; `FORBIDDEN` (403: the session
   *   belongs to an account and the caller lacks `clients:security`; or to another staff member who is an Owner and the caller is not, or whose
   *   role has permissions the caller does not hold, decision 046)
   */
  async remove(caller: StaffPrincipal, id: number): Promise<void> {
    const idle = await this.idleLimits();
    await this.db.runInTransaction(async (work) => {
      const found = await findListedSession(work.tx, id, this.clock.now(), idle);
      if (!found) throw new AppError('NOT_FOUND', { detail: 'No live session has this id.' });
      if (found.session.subjectType === 'account') {
        requirePermission(caller, END_ACCOUNT_SESSION_PERMISSION);
        // False only when a parallel request ended it first: the end state is the one asked for.
        await this.sessions.revoke(id, work);
        await this.audit.record(work.tx, {
          action: 'ended session of',
          entityType: 'account',
          entityId: found.session.subjectId,
          entityLabel: found.subjectName ?? `account ${found.session.subjectId}`,
          before: { sessionId: id, ip: found.session.ip },
          after: { ended: true },
        });
        return;
      }
      // Decision 046: ending another member's session acts on that account (the Owner rule and the privilege ceiling).
      if (found.session.subjectId !== caller.staffId) {
        const permissions = (await findStaffRow(work.tx, found.session.subjectId))?.role.permissions ?? [];
        assertOwnerTargetAllowed(caller, { permissions });
        assertWithinCeiling(caller, permissions, 'account');
      }
      // False only when a parallel request ended it first: the end state is the one asked for.
      await this.sessions.revoke(id, work);
      await this.audit.record(work.tx, {
        action: 'ended session of',
        entityType: 'session',
        entityId: id,
        entityLabel: found.subjectName ?? `staff ${found.session.subjectId}`,
        before: { subjectType: found.session.subjectType, subjectId: found.session.subjectId, ip: found.session.ip },
        after: { ended: true, own: id === caller.session.id },
      });
    });
  }

  private idleLimits(): Promise<IdleLimits> {
    return idleLimitsOf(this.policy);
  }
}

function toView(
  { session, subjectName, subjectEmail, subjectPermissions }: SessionWithSubject,
  caller: StaffPrincipal,
): SessionRowView {
  const ofAccount = session.subjectType === 'account';
  // The same reach as ending the session (decision 046): another member whose role the caller does not cover, an Owner's included. An
  // account has no role: its address is judged by the contact rule below.
  const aboveCeiling =
    !ofAccount &&
    session.subjectId !== caller.staffId &&
    uncoveredPermissions(caller.permissions, subjectPermissions ?? []).length > 0;
  const email =
    subjectEmail === null
      ? undefined
      : ofAccount
        ? customerEmailIn(customerContactOf(caller), subjectEmail)
        : subjectEmail;
  return {
    id: session.id,
    expiresAt: session.expiresAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    ip: aboveCeiling ? MASKED : session.ip,
    userAgent: aboveCeiling ? MASKED : session.userAgent,
    lastSeenAt: session.lastSeenAt.toISOString(),
    subjectType: session.subjectType,
    subject: {
      id: session.subjectId,
      name: subjectName ?? '',
      ...(email === undefined ? {} : { email }),
    },
    current: session.id === caller.session.id,
  };
}
