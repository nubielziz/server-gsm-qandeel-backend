// MerchantGroupMembers: the read-only view of how many accounts sit in each rank, for the catalog module's rank routes (the console's
// "accounts" column, the delete guard and the credit rule when a rank stops allowing overdraft).
import { Injectable } from '@nestjs/common';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { clients } from '../db/schema';

/**
 * Counts the accounts of ranks for modules that do not own the `clients` table.
 *
 * Why: the catalog module owns `client_groups` (the ranks) but not the accounts in them (decision 016); `GET /admin/client-groups` shows
 * `accountCount` for every rank, the retail rank included (decision 064: every account is a row of one table, a guest row too), `DELETE`
 * refuses a rank with accounts (`GROUP_IN_USE`), and `PATCH overdraftAllowed: false` must know whether a credit-holding account sits in the
 * rank (user rule 2). It has no dependencies, so a worker or a test can build it alone.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class MerchantGroupMembers {
  /**
   * Counts the accounts of several ranks at once, any status and any kind of row (a guest row counts).
   *
   * @param db the database or the caller's transaction
   * @param groupIds the ranks to count
   * @returns the number of accounts per rank id; a rank without accounts is `0`
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
   * Counts how many of some accounts belong to one rank.
   *
   * Why: the overdraft rule asks "does any account with a credit limit sit in this rank?", and the credit holders are few,
   * so the caller passes their ids instead of this service listing a whole rank.
   *
   * @param db the database or the caller's transaction
   * @param groupId the rank
   * @param clientIds the accounts to look at
   * @returns how many of `clientIds` are in the rank
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
