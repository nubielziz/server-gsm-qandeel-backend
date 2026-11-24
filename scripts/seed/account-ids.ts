// The one number space of the demo accounts (decision 064): a demo merchant keeps its number (`m3` is account 3) and a demo customer `cN` is
// account `100 + N` (`c3` is account 103), so an old customer number never names a converted merchant. The console's mock store applies the
// same rule (src/mocks/seed/accountIds.ts of the frontend): the seed and the mock list the same accounts under the same numbers.
import { demoNumericId } from './demo-state';

/** How far the demo customers' numbers move: customer 1 is account 101, and every merchant number is below it. */
export const CUSTOMER_ACCOUNT_OFFSET = 100;

/**
 * The first number of the guest accounts the checkout seed invents (one per address that left a checkout).
 *
 * Why: they must never meet the numbers of the demo's own accounts, whichever seeder runs first, and the accounts' id sequence stops
 * below them (`syncAccountIdentity`), so the next account made in a development database is 131, not 900 228.
 */
export const INVENTED_ACCOUNT_ID_FIRST = 900_000;

/**
 * The account number of an old customer number.
 *
 * @param customerId the demo customer's number (`c3` is 3)
 * @returns the account number, 100 more
 */
export function customerAccountId(customerId: number): number {
  return CUSTOMER_ACCOUNT_OFFSET + customerId;
}

/**
 * The account number of an old merchant number: the same number.
 *
 * @param merchantId the demo merchant's number (`m3` is 3)
 * @returns the account number
 */
export function merchantAccountId(merchantId: number): number {
  return merchantId;
}

/**
 * The account number behind a demo id: `m3` is 3, `c3` is 103.
 *
 * Why: every demo row that names a buyer, a requester or a recipient does it by one of these two ids; mapping them through one function
 * keeps the rule in one place.
 *
 * @param id a demo merchant id (`m<n>`) or customer id (`c<n>`)
 * @returns the account number
 * @throws {Error} when the id is neither
 */
export function accountIdOfDemo(id: string): number {
  const match = /^([cm])\d+$/.exec(id);
  if (!match) throw new Error(`Demo id "${id}" is not a merchant id (m<n>) or a customer id (c<n>).`);
  return match[1] === 'c' ? customerAccountId(demoNumericId(id)) : merchantAccountId(demoNumericId(id));
}
