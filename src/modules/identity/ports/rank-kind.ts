// The two kinds of right an account can hold, and how the stored kind of its rank decides between them (decision 064).

/**
 * What an account may do, told by the kind of its rank: `merchant` (the portal, API keys and the Dhru endpoint) or `retail` (the shop).
 *
 * Why: one account type serves both; the rank is the only thing that tells them apart (decision 064). The wire says `merchant` and
 * `retail`; the stored kinds of `client_groups` are `b2b` and `b2c_retail`.
 */
export type RankKind = 'retail' | 'merchant';

/** The one stored group kind that carries merchant rights. */
const MERCHANT_GROUP_KIND = 'b2b';

/**
 * Tells which rights a rank gives, from the `kind` stored on its group.
 *
 * Why: the check fails closed. Only `b2b` gives merchant rights; `b2c_retail`, a value the code has never heard of and an empty string all
 * give retail rights, so a typo or a new kind can never open the merchant surface by accident (decision 064).
 *
 * @param groupKind the `kind` of the account's `client_groups` row (an empty string when the row could not be read)
 * @returns `merchant` for `b2b`, `retail` for everything else
 * @see decision 064
 */
export function rankKindOf(groupKind: string): RankKind {
  return groupKind === MERCHANT_GROUP_KIND ? 'merchant' : 'retail';
}
