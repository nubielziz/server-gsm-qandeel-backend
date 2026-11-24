// The rules an API key must pass (decision 018, 026, 064): revoked, expired, the account's status, its rank kind and allowed IPs, as pure
// functions, plus how a refusal is worded on the Dhru surface (its envelope). No I/O here.
import { type IpAddress, formatIpAddress, networkContains, parseNetwork } from '../../../../../common/ip-address';
import { AppError } from '../../../../../common/errors';
import { canAct, sessionStateOf } from '../../../accounts/account-status';
import { type RankKind, rankKindOf } from '../../../ports/rank-kind';
import type { ClientStatus } from '../../../db/schema';

/**
 * An API key as the guards see it (and as the cache holds it: plain JSON, times in milliseconds).
 *
 * Why: decision 018 resolves the key by its keyed hash and checks revoked/expired, allowed IPs, the per-minute limit and
 * the account's status and rank kind; one cached view holds all of it, so a request costs one cache read. Never holds the key itself.
 */
export interface ApiKeyView {
  readonly id: number;
  /** HMAC of the key (decision 019): the cache key of this view and the row's lookup column. */
  readonly keyHash: string;
  readonly clientId: number;
  /** CIDR ranges as Postgres prints them; empty means any address. */
  readonly allowedIps: readonly string[];
  readonly rateLimitPerMin: number;
  readonly lastUsedAtMs: number | null;
  readonly expiresAtMs: number | null;
  readonly revokedAtMs: number | null;
  readonly client: {
    /** The Dhru username; `null` for an account that never had one (a retail account holds none). */
    readonly username: string | null;
    readonly name: string;
    readonly status: ClientStatus;
    /**
     * The rights of the account's rank when the view was loaded (read through `RankGroupReads`). Only `merchant` may use a key; a view
     * that lacks it (an older cached shape) is refused like a retail one, so the check fails closed (decision 064).
     */
    readonly rankKind: RankKind;
  };
}

/**
 * A stored key and its account as the table holds them: a view whose rank kind is still the id of the rank group.
 *
 * Why: the kind of a rank is the catalog's to read (`RankGroupReads`), never a join on its table, so the repository hands the group id
 * back and `ApiKeyDirectory` turns it into the `rankKind` of the view with {@link apiKeyViewOf}.
 */
export interface StoredApiKey extends Omit<ApiKeyView, 'client'> {
  readonly client: Omit<ApiKeyView['client'], 'rankKind'> & { readonly groupId: number };
}

/**
 * Builds the view of a stored key from the kind of its account's rank group.
 *
 * Why: a rank that cannot be read (its group is gone) or a kind this code does not know gives retail rights, so the key is refused: the
 * check fails closed, and only the stored kind `b2b` gives a key any use (decision 064).
 *
 * @param stored the key and its account as the table holds them
 * @param groupKind the stored kind of the account's rank group, or `undefined` when the group does not exist
 * @returns the view the guards and the cache use
 */
export function apiKeyViewOf(stored: StoredApiKey, groupKind: string | undefined): ApiKeyView {
  const { groupId: _groupId, ...account } = stored.client;
  return { ...stored, client: { ...account, rankKind: rankKindOf(groupKind ?? '') } };
}

/**
 * Why a key was refused.
 *
 * Why: tests and logs tell the cases apart; {@link refusalFor} words each one for the surface.
 */
export type ApiKeyRefusalReason =
  'unauthenticated' | 'revoked' | 'expired' | 'suspended' | 'not_active' | 'not_merchant' | 'ip_not_allowed';

/** What {@link checkApiKey} needs to know about the request. */
export interface ApiKeyCheck {
  /** The current time in milliseconds. */
  readonly nowMs: number;
  /** The client address; `undefined` when it could not be read. */
  readonly address: IpAddress | undefined;
}

/**
 * Tells whether an address is covered by a key's list of allowed ranges.
 *
 * Why: decision 018: a key may be limited to the merchant's server addresses (IPv4 and IPv6, single addresses or CIDR). An empty
 * list means "any address". A list whose entries cannot be read matches nothing: a broken restriction must not open the key.
 *
 * @param allowed the ranges (`203.0.113.0/24`, `2001:db8::1`)
 * @param address the client address; `undefined` when it could not be read
 * @returns true when the key may be used from the address
 */
export function ipAllowedForKey(allowed: readonly string[], address: IpAddress | undefined): boolean {
  if (allowed.length === 0) return true;
  if (!address) return false;
  return allowed.some((range) => {
    const network = parseNetwork(range);
    return network !== undefined && networkContains(network, address);
  });
}

/**
 * Runs the checks that follow a successful lookup, in order.
 *
 * Why: revoked and expired keys are refused as unauthenticated; an account that is suspended or blocked cannot use its keys (they are
 * kept: reactivation restores them); an account that is not active for another reason (erased) cannot either; a key works only for an
 * account of a merchant rank, so a key that outlived a move to the retail rank (a second wall behind the revoke) is refused; then the
 * network. A key carries no scope: every live key of an active merchant is a Dhru credential (decision 026). The status is read through
 * `sessionStateOf` and `canAct`, never compared with a word (decision 064).
 *
 * @param view the key and its account
 * @param check the time and the client address
 * @returns the reason the key is refused, or `undefined` when every check passes
 */
export function checkApiKey(view: ApiKeyView, check: ApiKeyCheck): ApiKeyRefusalReason | undefined {
  if (view.revokedAtMs !== null) return 'revoked';
  if (view.expiresAtMs !== null && view.expiresAtMs <= check.nowMs) return 'expired';
  if (sessionStateOf(view.client.status) === 'suspended') return 'suspended';
  if (!canAct(view.client.status)) return 'not_active';
  if (view.client.rankKind !== 'merchant') return 'not_merchant';
  if (!ipAllowedForKey(view.allowedIps, check.address)) return 'ip_not_allowed';
  return undefined;
}

/** The standard Dhru message for a credential that is not accepted (decision 026). */
const DHRU_AUTH_FAILED = 'Authentication Failed';

/**
 * Words a refusal for the Dhru surface.
 *
 * Why: the Dhru surface always answers HTTP 200 with its envelope, and client software knows `Authentication Failed` (decision 026). A
 * credential that is not accepted gets that standard message and nothing more: a key of an account that is not active or not of a merchant
 * rank is such a credential, and says nothing about the account. Once the key and the username are proven, the merchant is told what is
 * wrong (a network address that is not on the key's list, a suspended account), because only the owner of the credentials can see it.
 *
 * @param reason why the key was refused
 * @param address the client address, named in the message about allowed IPs
 * @returns the error to throw
 */
export function refusalFor(reason: ApiKeyRefusalReason, address: IpAddress | undefined): AppError {
  switch (reason) {
    case 'unauthenticated':
    case 'revoked':
    case 'expired':
    case 'not_active':
    case 'not_merchant':
      return new AppError('UNAUTHORIZED', { detail: DHRU_AUTH_FAILED });
    case 'suspended':
      return new AppError('ACCOUNT_SUSPENDED', { detail: 'This merchant account is suspended.' });
    case 'ip_not_allowed': {
      const who = address ? `Your network address (${formatIpAddress(address)})` : 'Your network address';
      return new AppError('IP_NOT_ALLOWED', {
        detail: `${who} is not on the list of addresses allowed for this API key.`,
      });
    }
  }
}
