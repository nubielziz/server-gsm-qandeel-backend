// Who is calling: the principals the session guards produce, plus the Owner helpers of decision 018.
// Machine access kinds (API keys, Dhru credentials) add their principals here when P2.5c builds them.
import { AppError } from '../../../common/errors';
import type { SessionStage } from '../db/schema';
import { grantsEverything } from './permission-grammar';
import type { SessionView } from './session.types';

/**
 * Anything that holds permissions: a principal, or the permissions of a role.
 *
 * Why: the Owner helpers judge both the caller (a principal) and the target (a staff member's role) with one type.
 */
export interface PermissionHolder {
  readonly permissions: readonly string[];
}

/**
 * A signed-in staff member (admin console).
 *
 * Why: handlers need the id for ownership and audit, the permissions for the Owner rules, and the session for the sign-in
 * steps that rotate or revoke it. A pending sign-in session has no permissions.
 */
export interface StaffPrincipal extends PermissionHolder {
  readonly kind: 'staff';
  readonly staffId: number;
  readonly roleId: number;
  readonly stage: SessionStage;
  readonly ip: string;
  readonly session: SessionView;
}

/**
 * A signed-in merchant (client portal).
 *
 * Why: portal handlers act on the merchant's own records only, by this id.
 */
export interface MerchantPrincipal {
  readonly kind: 'merchant';
  readonly clientId: number;
  readonly stage: SessionStage;
  readonly ip: string;
  readonly session: SessionView;
}

/**
 * A signed-in storefront customer.
 *
 * Why: account routes act on the customer's own records only, by this id.
 */
export interface CustomerPrincipal {
  readonly kind: 'customer';
  readonly customerId: number;
  readonly stage: SessionStage;
  readonly ip: string;
  readonly session: SessionView;
}

/**
 * The callers authenticated by a session cookie.
 *
 * Why: the three subjects share one session service (decision 018).
 */
export type SessionPrincipal = StaffPrincipal | MerchantPrincipal | CustomerPrincipal;

/**
 * Every kind of caller a guard can produce.
 *
 * Why: handlers and the audit read it; P2.5c adds the API-key principal (client id, key id, scopes).
 */
export type Principal = SessionPrincipal;

/**
 * Tells whether a staff member is an Owner.
 *
 * Why: decision 018 (MISMATCHES B113): an Owner is a staff member whose role contains `*`. The map protects "the last
 * owner" without defining an Owner.
 *
 * @param holder a principal, or `{ permissions }` of a staff member's role
 * @returns true when the permissions include `*`
 */
export function isOwner(holder: PermissionHolder): boolean {
  return grantsEverything(holder.permissions);
}

/**
 * Refuses an action on an Owner account unless the caller is an Owner too.
 *
 * Why: decision 018: "actions on an Owner account need `*`", so a delegated admin cannot reset the password, 2FA or sessions
 * of an Owner. It is not a session-ending code: `403 FORBIDDEN` never signs the caller out.
 *
 * @param caller the signed-in staff member
 * @param target the staff member the action is about (the permissions of their role)
 * @throws {AppError} `FORBIDDEN` (403) when the target is an Owner and the caller is not
 */
export function assertOwnerTargetAllowed(caller: PermissionHolder, target: PermissionHolder): void {
  if (isOwner(target) && !isOwner(caller)) {
    throw new AppError('FORBIDDEN', { detail: 'Only an owner can do this to an owner account.' });
  }
}
