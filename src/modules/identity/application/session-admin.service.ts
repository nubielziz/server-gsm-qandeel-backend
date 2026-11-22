// SessionAdminService: the use cases of the admin session routes (map domain A, stage 2): the live sessions of staff and
// merchants, and ending one of them.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import { type SessionWithSubject, findListedSession, listLiveSessions } from '../infra/session-admin.repository';
import { findStaffRow } from '../infra/staff-admin.repository';
import { maskCustomerEmail } from '../../../common/customer-contact';
import { grants, uncoveredPermissions } from '../security/permission-grammar';
import { assertOwnerTargetAllowed, assertWithinCeiling, requirePermission } from '../security/principal';
import type { PermissionHolder, StaffPrincipal } from '../security/principal';
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

/** What the list shows in place of an address or a device that the caller may not read. */
const MASKED = '•••';

/** The permission that shows a merchant's email address in full. */
const MERCHANT_READ_PERMISSION = 'clients:read';

/** The permission that ending a merchant's session needs besides the route's own (the merchant page's "sign out everywhere"). */
const MERCHANT_SECURITY_PERMISSION = 'clients:security';

/**
 * Lists and ends sessions for staff.
 *
 * Why: scenario admin-team and ip-rules, RESOLUTIONS identity-platform-6: "active" is one rule everywhere (not revoked, not
 * past its end, used within the idle limit). The list shows fully signed-in staff and merchant sessions only (B9). Decisions 046
 * and 047: the list reads only what the caller's permissions cover, and ending a merchant's session needs the permission of the
 * merchant's security tools.
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
   * Why: decisions 046 and 047: the address and the device of another staff member's session are masked when that member's role
   * holds permissions the caller does not hold (an Owner's, for a caller who is not an Owner); a merchant's email address is masked
   * unless the caller holds `clients:read`. The rows keep their shape.
   *
   * @param caller the signed-in staff member (their own session is marked `current`)
   * @param query the parsed list request
   * @returns the page of sessions and the exact total
   * @throws {AppError} `VALIDATION_FAILED` (422 on `subjectId` when `subjectType` is missing: ids of staff and merchants overlap)
   */
  async list(
    caller: StaffPrincipal,
    query: ParsedListQuery<'lastSeenAt' | 'createdAt' | 'id'>,
  ): Promise<{ rows: SessionRowView[]; total: number }> {
    if (query.filters.some((f) => f.field === 'subjectId') && !query.filters.some((f) => f.field === 'subjectType')) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'subjectId', code: 'invalid', message: 'Send subjectType together with subjectId.' }],
      });
    }
    const { rows, total } = await listLiveSessions(this.db.db, query, this.clock.now(), await this.idleLimits());
    return { rows: rows.map((row) => toView(row, caller)), total };
  }

  /**
   * Ends a live session. The audit row of a merchant's session is filed under the merchant (`merchant`), a staff session keeps `session`.
   *
   * Why: decisions 046 and 047: ending a merchant's session acts on the merchant's sign-in, as the merchant page's "sign out
   * everywhere" does, so it needs `clients:security` as well.
   *
   * @param caller the signed-in staff member
   * @param id the session id
   * @throws {AppError} `NOT_FOUND` (404) when the session is unknown or no longer live by the list's rule, `FORBIDDEN` (403: the
   *   session belongs to another staff member who is an Owner and the caller is not, or whose role has permissions the caller does
   *   not hold, decision 046; or the session is a merchant's and the caller lacks `clients:security`, decision 047)
   */
  async remove(caller: StaffPrincipal, id: number): Promise<void> {
    const idle = await this.idleLimits();
    await this.db.runInTransaction(async (work) => {
      const found = await findListedSession(work.tx, id, this.clock.now(), idle);
      if (!found) throw new AppError('NOT_FOUND', { detail: 'No live session has this id.' });
      // Decision 046: ending another member's session acts on that account (the Owner rule and the privilege ceiling).
      if (found.session.subjectType === 'staff' && found.session.subjectId !== caller.staffId) {
        const permissions = (await findStaffRow(work.tx, found.session.subjectId))?.role.permissions ?? [];
        assertOwnerTargetAllowed(caller, { permissions });
        assertWithinCeiling(caller, permissions, 'account');
      }
      if (found.session.subjectType === 'client') requirePermission(caller, MERCHANT_SECURITY_PERMISSION);
      // False only when a parallel request ended it first: the end state is the one asked for.
      await this.sessions.revoke(id, work);
      // A merchant's session is filed under the merchant, so the merchant page's audit history shows it (feature 20, O-12).
      if (found.session.subjectType === 'client') {
        await this.audit.record(work.tx, {
          action: 'ended a session of',
          entityType: 'merchant',
          entityId: found.session.subjectId,
          entityLabel: found.subjectName ?? `client ${found.session.subjectId}`,
          before: { sessionId: id, ip: found.session.ip },
          after: { ended: true },
        });
        return;
      }
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

function toView(
  { session, subjectName, subjectEmail, subjectPermissions }: SessionWithSubject,
  caller: StaffPrincipal,
): SessionRowView {
  const isClient = session.subjectType === 'client';
  // The same reach as ending the session (decision 046): another member whose role the caller does not cover, an Owner's included.
  const aboveCeiling =
    !isClient &&
    session.subjectId !== caller.staffId &&
    uncoveredPermissions(caller.permissions, subjectPermissions ?? []).length > 0;
  const emailInFull = !isClient || mayReadMerchants(caller);
  return {
    id: session.id,
    expiresAt: session.expiresAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    ip: aboveCeiling ? MASKED : session.ip,
    userAgent: aboveCeiling ? MASKED : session.userAgent,
    lastSeenAt: session.lastSeenAt.toISOString(),
    subjectType: isClient ? 'client' : 'staff',
    subject: {
      id: session.subjectId,
      name: subjectName ?? '',
      ...(subjectEmail === null ? {} : { email: emailInFull ? subjectEmail : maskCustomerEmail(subjectEmail) }),
    },
    current: session.id === caller.session.id,
  };
}

function mayReadMerchants(caller: PermissionHolder): boolean {
  return grants(caller.permissions, MERCHANT_READ_PERMISSION);
}
