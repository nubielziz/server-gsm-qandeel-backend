// The pinned list of the routes that every account may call, whatever its rank (decision 064, the one account type).
// Read by rank-open-routes.test.ts, which fails when this list and the `rank: 'any'` routes of the contract registry differ:
// opening a route to every account is a reviewed change of two files, the contract and this list.
import type { RouteKey } from '@src/common/contract/define-route';

/**
 * Every route declared with `rank: 'any'`, in alphabetical order of its key.
 *
 * Why: the rank gate is default deny (`merchant-session` serves merchant ranks, `customer-session` the retail rank); the few routes
 * that every signed-in account needs are named here once, so a reviewer sees each opening. They are the sign-out routes, the
 * second sign-in step and the password change that every account has, and the two privacy routes of the shop that every account
 * may use (a merchant rank is told to ask for the retail rank before it can ask for erasure).
 *
 * Expand release: six keys. The contract release retires the alias sign-out of the shop (`POST /store/v1/auth/logout`) and the list
 * has five.
 *
 * @see test/contract/rank-open-routes.test.ts
 * @see docs/decisions/064-one-account-type.md
 */
export const RANK_OPEN_ROUTES = [
  'POST /client/auth/2fa',
  'POST /client/auth/logout',
  'POST /client/auth/password/change',
  'POST /store/v1/auth/logout',
  'POST /store/v1/me/data-delete',
  'POST /store/v1/me/data-export',
] as const satisfies readonly RouteKey[];
