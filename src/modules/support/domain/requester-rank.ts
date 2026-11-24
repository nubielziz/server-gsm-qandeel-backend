// The rank kind of a ticket's requester, as the staff views show it (decision 064). Pure.
import type { RankKind } from '../../identity';

/**
 * Tells the rank kind of a requester from the rank it holds and the one retail rank.
 *
 * Why: the console tells a merchant's ticket from a shop buyer's by `requester.rankKind` (the Merchant tag, the Who control), and every
 * account is one row now, so the answer is the rank of the requester's row. The catalog owns the ranks and its port gives the id of the
 * one retail rank (`RankGroupReads.retailGroupId`); any other rank is a merchant rank, because the kinds are closed to the two.
 * The answer fails closed: a requester that is gone or has no rank reads as retail, never as merchant.
 *
 * @param groupId the rank of the requester's row, or `null` when the row is gone
 * @param retailGroupId the id of the retail rank
 * @returns `merchant` for a row that holds a rank other than the retail one, `retail` otherwise
 */
export function rankKindOfRequester(groupId: number | null, retailGroupId: number): RankKind {
  return groupId !== null && groupId !== retailGroupId ? 'merchant' : 'retail';
}
