// The permission that guards the ways staff could hand themselves a storefront customer's account (decision 047).

/**
 * The permission of an email change of an account and of an account created with a temporary password, besides the route's own.
 *
 * Why: decision 047: `customers:password` already guards temporary passwords and ended sessions; the address is where an account's
 * sign-in links go and a temporary password is a working credential, so both need it too (the routes keep `customers:update`).
 */
export const CUSTOMER_ACCOUNT_SECURITY_PERMISSION = 'customers:password' as const;
