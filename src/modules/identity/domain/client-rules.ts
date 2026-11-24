// Pure rules of the staff status writes on an account: the status machine, who may reactivate an account that was never approved, the Dhru
// username (a merchant rank has one), and the suspension reason. No I/O, so the rules are unit-tested.
import { isSuspended } from '../accounts/account-status';
import type { ClientStatus } from '../db/schema';
import type { RankKind } from '../ports/rank-kind';

/**
 * The only status changes staff make with `PATCH /admin/clients/:id`: suspend and reactivate. A blocked or anonymized account moves only
 * through its own route (block, unblock, anonymize), so it has no entry here; `pending` no longer exists (decision 064).
 */
const TRANSITIONS: Readonly<Record<ClientStatus, readonly ClientStatus[]>> = {
  suspended: ['active'],
  active: ['suspended'],
  blocked: [],
  anonymized: [],
};

/**
 * Tells whether staff may move an account from one status to another with the PATCH.
 *
 * Why: `suspended → active` (reactivate) and `active → suspended` (suspend); anything else is
 * `409 INVALID_TRANSITION` (identity.md, PATCH /admin/clients/:id).
 *
 * @param from the current status
 * @param to the wanted status
 * @returns true when the change is one of the two
 */
export function canMoveClient(from: ClientStatus, to: ClientStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * The permission a status change of an account needs besides `clients:update`.
 *
 * Why: decision 046: a suspension and lifting a suspension decide who may use the account, so they need the account-security permission.
 *
 * @param from the current status
 * @param to the wanted status
 * @returns `clients:security` for a move into or out of `suspended`, else `null`
 */
export function statusChangePermission(from: ClientStatus, to: ClientStatus): 'clients:security' | null {
  return from === 'suspended' || to === 'suspended' ? 'clients:security' : null;
}

/**
 * The reason the retirement of the approval step wrote, by nobody (`suspended_by` null), on every merchant row that was still waiting for
 * approval (migrations 0065 and 0066): together they mark an account that was never approved.
 */
export const NEVER_APPROVED_REASON =
  'This account was never activated, so it was suspended. Staff can review it and reactivate it.';

/** The refusal of a reactivation of a never-approved merchant by anyone but the Owner (`403 FORBIDDEN`). */
export const NEVER_APPROVED_OWNER_DETAIL = 'Only the Owner may activate an account that was never approved.';

/**
 * Tells whether a status change makes active a merchant-rank account that was never approved, which only the Owner may do.
 *
 * Why: the approval step of merchant sign-up was retired (decision 062) and a row still waiting for it was suspended with one fixed
 * reason, by nobody. It may be a sign-up nobody vetted: making it active gives a working merchant (a wallet, a rank that may allow credit,
 * a Dhru username and API keys), the Owner's decision, as a merchant-rank create is (decision 064). A suspension staff wrote has an author,
 * so it never matches, even with the same words.
 *
 * @param account the account's status, rank kind and suspension columns, read under its row lock
 * @param to the wanted status
 * @returns true when the change needs the Owner
 */
export function reactivationNeedsOwner(
  account: {
    readonly status: ClientStatus;
    readonly rankKind: RankKind;
    readonly suspendedBy: number | null;
    readonly suspendedReason: string | null;
  },
  to: ClientStatus,
): boolean {
  return (
    to === 'active' &&
    isSuspended(account.status) &&
    account.rankKind === 'merchant' &&
    account.suspendedBy === null &&
    account.suspendedReason === NEVER_APPROVED_REASON
  );
}

/**
 * The permission an email change of an account with a login needs besides `clients:update`.
 *
 * Why: decision 047: the address is where the account's sign-in and password links go, so changing it is an account-security action,
 * like a temporary password. (A guest row's address needs only `clients:update`: see `emailChangePermission` in `account-rules.ts`.)
 */
export const MERCHANT_EMAIL_CHANGE_PERMISSION = 'clients:security' as const;

/** The shortest and longest suspension reason (the console's dialog and the endpoint doc). */
export const SUSPEND_REASON_LENGTH = { min: 3, max: 140 } as const;

/**
 * Checks a suspension reason.
 *
 * @param reason the reason as sent (already trimmed)
 * @returns the sentence for the `reason` field, or `undefined` when it is acceptable
 */
export function suspendReasonProblem(reason: string | undefined): string | undefined {
  if (reason === undefined || reason.length < SUSPEND_REASON_LENGTH.min) {
    return `Say why, in at least ${SUSPEND_REASON_LENGTH.min} characters.`;
  }
  return reason.length > SUSPEND_REASON_LENGTH.max ? `Use at most ${SUSPEND_REASON_LENGTH.max} characters.` : undefined;
}

/**
 * Makes the first choice of the Dhru username of an account with a merchant rank from its name.
 *
 * Why: the username is what Dhru client software signs in with; it is lower case letters, digits and hyphens, and unique
 * case-insensitively. Collisions get a numeric suffix from {@link usernameCandidate}. `AccountRanks.ensureUsername` (the rank change) and
 * the staff create of a merchant account both use these two functions.
 *
 * @param name the account's name
 * @returns the slug, `merchant` when the name has no letters or digits
 */
export function usernameBase(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return slug === '' ? 'merchant' : slug;
}

/**
 * Names the nth candidate username: the base, then `base-2`, `base-3`, ...
 *
 * @param base the slug from {@link usernameBase}
 * @param attempt 1 for the base itself
 * @returns the candidate
 */
export function usernameCandidate(base: string, attempt: number): string {
  return attempt <= 1 ? base : `${base}-${attempt}`;
}
