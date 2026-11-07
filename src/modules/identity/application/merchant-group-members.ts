// MerchantGroupMembers: the read-only view of how many merchants sit in each merchant group, for the catalog module's group
// routes (the console's "merchants" column, the delete guard and the credit rule when a group stops allowing overdraft).
import { Injectable } from '@nestjs/common';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { clients } from '../db/schema';

/**
 * Counts the merchants of groups for modules that do not own the `clients` table.
 *
 * Why: the catalog module owns `client_groups` but not the merchants in them (decision 016); `GET /admin/client-groups` shows
 * `merchantCount`, `DELETE` refuses a group with merchants (`GROUP_IN_USE`), and `PATCH overdraftAllowed: false` must know
 * whether a credit-holding merchant sits in the group (user rule 2). It has no dependencies, so a worker or a test can build it
 * alone.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class MerchantGroupMembers {
  /**
   * Counts the merchants of several groups at once, any status.
   *
   * @param db the database or the caller's transaction
   * @param groupIds the groups to count
   * @returns the number of merchants per group id; a group without merchants is `0`
   */
  async countByGroup(db: DbExecutor, groupIds: readonly number[]): Promise<Map<number, number>> {
    const counts = new Map<number, number>(groupIds.map((id) => [id, 0]));
    if (groupIds.length === 0) return counts;
    const rows = await db
      .select({ groupId: clients.groupId, total: count() })
      .from(clients)
      .where(inArray(clients.groupId, [...groupIds]))
      .groupBy(clients.groupId);
    for (const row of rows) counts.set(row.groupId, row.total);
    return counts;
  }

  /**
   * Counts how many of some merchants belong to one group.
   *
   * Why: the overdraft rule asks "does any merchant with a credit limit sit in this group?", and the credit holders are few,
   * so the caller passes their ids instead of this service listing a whole group.
   *
   * @param db the database or the caller's transaction
   * @param groupId the group
   * @param clientIds the merchants to look at
   * @returns how many of `clientIds` are in the group
   */
  async countInGroup(db: DbExecutor, groupId: number, clientIds: readonly number[]): Promise<number> {
    if (clientIds.length === 0) return 0;
    const [row] = await db
      .select({ total: count() })
      .from(clients)
      .where(and(eq(clients.groupId, groupId), inArray(clients.id, [...clientIds])));
    return row?.total ?? 0;
  }
}
