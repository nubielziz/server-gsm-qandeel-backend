// Who is calling: the principals the session and machine guards produce, plus the Owner helpers of decision 018.
import { AppError } from '../../../common/errors';
import type { SessionStage } from '../db/schema';
import type { CapabilityAccessKind } from './machine/capability-tokens';
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
 * A merchant's API key (REST v1 with a Bearer key, Dhru with username and `apiaccesskey`).
 *
 * Why: decision 018: both resolve an `api_keys` row, and the orders, wallet and catalog handlers act for `clientId`; the key id
 * goes into the order's `api_key_id` and the scopes say what the key may call. The key itself is never kept.
 */
export interface ApiKeyPrincipal {
  readonly kind: 'api-key';
  readonly clientId: number;
  readonly keyId: number;
  readonly scopes: readonly string[];
  readonly ip: string;
}

/**
 * The holder of a capability token (a checkout, tracking, ticket or sign-in link token).
 *
 * Why: the token is the only credential of these storefront routes (decision 010); the owning module's resolver turned it into
 * the id of the record it opens, so the handler does not look the token up a second time.
 */
export interface CapabilityPrincipal {
  readonly kind: 'capability';
  /** Which kind of token opened the route. */
  readonly access: CapabilityAccessKind;
  /** The id the resolver returned (the checkout session, order, ticket or one-time token the token stands for). */
  readonly resourceId: number;
  readonly ip: string;
}

/**
 * A verified incoming gateway webhook.
 *
 * Why: the handler needs the gateway, the gateway's event id and the signed time, and a hint whether this event arrived before (a
 * gateway retries), so that it can acknowledge a repeat cheaply. `duplicate` is only a hint: the first delivery may still be
 * running or may fail, so the handler skips the work only when its own record (the payment row, unique on the gateway event id)
 * shows the event done, and the processing stays idempotent in Postgres.
 */
export interface WebhookPrincipal {
  readonly kind: 'webhook';
  /** The gateway slug from the URL (`stripe`, `wise`). */
  readonly gateway: string;
  /** The gateway's id of the event, as the adapter read it from the signed delivery. */
  readonly eventId: string;
  /** The time the gateway signed, in unix seconds. */
  readonly timestamp: number;
  /** True when this event id was accepted before in the replay window. */
  readonly duplicate: boolean;
  readonly ip: string;
}

/**
 * The callers authenticated by a credential other than a session cookie.
 *
 * Why: P2.5c: API keys, capability tokens and gateway signatures each produce their own principal.
 */
export type MachinePrincipal = ApiKeyPrincipal | CapabilityPrincipal | WebhookPrincipal;

/**
 * Every kind of caller a guard can produce.
 *
 * Why: handlers and the audit read it (`@CurrentPrincipal()`); a handler narrows it with `principal.kind`.
 */
export type Principal = SessionPrincipal | MachinePrincipal;

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
