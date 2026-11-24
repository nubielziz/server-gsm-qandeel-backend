// The staff audience of notification campaigns (identity module, feature 23, plan section 5.3): active staff members, optionally of
// some roles, plus listed people; one predicate serves the count, the fan-out's pages and the send-time check.
import { Injectable } from '@nestjs/common';
import { type SQL, and, asc, gt, inArray, notInArray, or, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import {
  type AudienceCounts,
  type AudienceFlagsSql,
  type AudienceMember,
  type AudienceProvider,
  type AudienceQuery,
  type NotificationCampaignPurpose,
  type StaffSegment,
  audienceCountFields,
  memberQuery,
} from '../../platform';
import { staffUsers } from '../db/schema';

/** Staff read in the console and by email. */
const FLAGS: AudienceFlagsSql = { inApp: sql`true`, email: sql`true` };

/**
 * The condition of the staff audience.
 *
 * Why: plan 5.1: only `active` staff; the segment's roles, or every role when the segment is `{}`; listed people are added and
 * excluded people removed after the segment.
 *
 * @param query the selection
 * @returns a condition over `staff_users`
 */
export function staffAudienceSql(query: AudienceQuery): SQL {
  const segment = query.segment as StaffSegment | undefined;
  const parts: SQL[] = [];
  if (segment !== undefined) parts.push(segment.roleIds ? inArray(staffUsers.roleId, segment.roleIds) : sql`true`);
  if (query.include.length > 0) parts.push(inArray(staffUsers.id, [...query.include]));
  const selected = parts.length === 0 ? sql`false` : (or(...parts) ?? sql`false`);
  return and(
    sql`${staffUsers.status} = 'active'`,
    selected,
    query.exclude.length > 0 ? notInArray(staffUsers.id, [...query.exclude]) : undefined,
  )!;
}

/**
 * Selects and counts staff for campaigns.
 *
 * Why: identity owns `staff_users`; platform reaches the table only through this provider (decision 032).
 */
@Injectable()
export class StaffAudience implements AudienceProvider {
  readonly kind = 'staff' as const;

  /**
   * Counts the audience.
   *
   * @param db the pool or a transaction
   * @param query the selection, purpose and channels
   * @returns the counts (`noConsent` is always 0: staff need no marketing consent)
   */
  async count(db: DbExecutor, query: AudienceQuery): Promise<AudienceCounts> {
    const [row] = await db
      .select(audienceCountFields(FLAGS, query.channels))
      .from(staffUsers)
      .where(staffAudienceSql(query));
    return { ...row!, noConsent: 0 };
  }

  /**
   * Reads one page of the audience.
   *
   * @param db the pool or a transaction
   * @param query the selection
   * @param afterId the last id of the previous page
   * @param limit the page size
   * @returns the members, id ascending
   */
  async page(db: DbExecutor, query: AudienceQuery, afterId: number, limit: number): Promise<AudienceMember[]> {
    const rows = await db
      .select({ id: staffUsers.id })
      .from(staffUsers)
      .where(and(staffAudienceSql(query), gt(staffUsers.id, afterId)))
      .orderBy(asc(staffUsers.id))
      .limit(limit);
    return rows.map((row) => ({ id: row.id, inApp: true, email: true }));
  }

  /**
   * Tells whether one staff member may still get a campaign.
   *
   * @param db the pool or a transaction
   * @param purpose the campaign's purpose
   * @param id the staff member
   * @returns the member, or `undefined` when gone or not active
   */
  async member(db: DbExecutor, purpose: NotificationCampaignPurpose, id: number): Promise<AudienceMember | undefined> {
    const [member] = await this.page(db, memberQuery(purpose, id), 0, 1);
    return member;
  }
}
