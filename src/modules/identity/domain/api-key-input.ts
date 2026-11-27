// Pure rules of the API keys of an account (staff's routes under /admin and the read of /client/api-keys, B155, decision 067): how the allowed addresses are checked and written, how a new
// key looks and how a stored key reads on the wire. No I/O.
import { type FieldError } from '../../../common/errors';
import { cidrToWire, normaliseCidr } from './ip-rule-input';

/** An account may hold at most this many keys that are neither revoked nor expired. */
export const MAX_LIVE_KEYS = 10;
/** A key may list at most this many allowed addresses or ranges. */
export const MAX_ALLOWED_IPS = 20;
/** The text a key's default name starts with: `API key 1`, `API key 2`, ... (decision 078). */
export const DEFAULT_KEY_NAME_PREFIX = 'API key ';
/** The per-minute limit a key starts with unless staff set another; only staff create keys and change the limit (B155, decision 067). */
export const DEFAULT_RATE_LIMIT_PER_MIN = 60;
/**
 * The per-minute limit staff may give a key when they create or edit it (feature 20, R5 and R6).
 *
 * Why: a key's limit is the ceiling of calls per minute; 6000 (100 a second) is far above a normal integration and still
 * bounded, so a typing mistake cannot switch the limit off.
 */
export const RATE_LIMIT_PER_MIN_RANGE = { min: 1, max: 6000 } as const;
/** How many leading characters of the key are kept for display: decision 019 says 8. */
export const API_KEY_PREFIX_LENGTH = 8;
/** Every key starts with this text, so a leaked key is recognisable in a scan of public code. */
export const API_KEY_LEADER = 'gsm_';

/** A checked list: the values to store, or the field errors to answer. */
export type Checked<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: FieldError[] };

/**
 * Checks the allowed addresses of a key and writes them the way `api_keys.allowed_ips` stores them.
 *
 * Why: B155 and identity-platform-5: an entry is an address or a CIDR range; a bare address is stored as `/32` or `/128`, host
 * bits after the prefix are a typing mistake (the same check the IP rules use), and an empty list means any address.
 *
 * @param entries the entries as sent
 * @returns the stored spellings without repeats, or one error per refused entry (`allowedIps.N`)
 */
export function checkAllowedIps(entries: readonly string[]): Checked<string[]> {
  const errors: FieldError[] = [];
  const stored: string[] = [];
  entries.forEach((entry, index) => {
    const result = normaliseCidr(entry);
    if (!result.ok) errors.push({ field: `allowedIps.${index}`, code: 'invalid_ip', message: result.message });
    else if (!stored.includes(result.stored)) stored.push(result.stored);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: stored };
}

/**
 * Names a key that was created without a name.
 *
 * Why: decision 078: the owner makes a key with one click and renames it later, so the server names it `API key <n>`, n being the smallest
 * whole number from 1 that no key of the account already carries in that exact form (a revoked key keeps its name, so its number is not
 * handed out again and two keys of one account are never told apart by the number alone being reused). A name that only looks alike
 * (`API key 01`, `api key 2`, `API key 2 `, `API key 2b`) does not hold a number.
 *
 * @param names the names of every key of the account, revoked and expired ones included (other names may be among them)
 * @returns `API key ` and the smallest number nobody holds
 */
export function nextDefaultKeyName(names: readonly string[]): string {
  const used = new Set<number>();
  for (const name of names) {
    if (!name.startsWith(DEFAULT_KEY_NAME_PREFIX)) continue;
    const digits = name.slice(DEFAULT_KEY_NAME_PREFIX.length);
    if (/^[1-9][0-9]{0,8}$/.test(digits)) used.add(Number(digits));
  }
  let number = 1;
  while (used.has(number)) number += 1;
  return `${DEFAULT_KEY_NAME_PREFIX}${number}`;
}

/**
 * How a change of a key's address list, per-minute limit and expiry moves its reach: it changes nothing, only narrows it, or widens
 * it. A new name is no change of reach.
 */
export type KeyChangeKind = 'none' | 'narrows' | 'widens';

/**
 * Judges whether a change of a key's allowed addresses, per-minute limit and expiry widens the key.
 *
 * Why: the address list, the limit and the period of validity set how far a key reaches: removing the list, adding an address,
 * raising the limit, removing the expiry or moving it later (also from a time that has passed, which brings an expired key back) gives
 * the key more reach, so that change is kept for Owners and staff who are not Owners may only narrow a key (decision 046, decision 078).
 * A first expiry on a key that never expired and an earlier one narrow it.
 * An empty list means every address, so it is the widest list; a list is no wider than the stored one when every entry of it
 * is also stored (a narrower range inside a stored range is not recognised and counts as a widening, which only an Owner
 * may then make). A change that widens one part widens the key, whatever the other part does.
 *
 * @param stored the key as it is stored (addresses in their stored spelling; a missing `expiresAt` reads as no expiry)
 * @param next the new values, in the stored spelling; a missing one stays as it is (`expiresAt` `null` removes the expiry)
 * @returns `widens` when an address list or limit gets wider, `narrows` when a value gets narrower and none gets wider, `none` when nothing changes
 */
export function classifyKeyChange(
  stored: {
    readonly allowedIps: readonly string[];
    readonly rateLimitPerMin: number;
    readonly expiresAt?: Date | null | undefined;
  },
  next: {
    readonly allowedIps?: readonly string[] | undefined;
    readonly rateLimitPerMin?: number | undefined;
    readonly expiresAt?: Date | null | undefined;
  },
): KeyChangeKind {
  let narrows = false;
  if (next.expiresAt !== undefined) {
    const before = stored.expiresAt ?? null;
    const after = next.expiresAt;
    if (after === null) {
      if (before !== null) return 'widens';
    } else if (before === null) {
      narrows = true;
    } else if (after.getTime() > before.getTime()) {
      return 'widens';
    } else if (after.getTime() < before.getTime()) {
      narrows = true;
    }
  }
  if (next.rateLimitPerMin !== undefined && next.rateLimitPerMin !== stored.rateLimitPerMin) {
    if (next.rateLimitPerMin > stored.rateLimitPerMin) return 'widens';
    narrows = true;
  }
  if (next.allowedIps !== undefined) {
    const current = new Set(stored.allowedIps);
    const proposed = new Set(next.allowedIps);
    const isSubset = current.size === 0 || (proposed.size > 0 && [...proposed].every((entry) => current.has(entry)));
    if (!isSubset) return 'widens';
    if (proposed.size !== current.size) narrows = true;
  }
  return narrows ? 'narrows' : 'none';
}

/**
 * Builds the text of a new key from random token text.
 *
 * Why: decision 019: the key is shown once and only its keyed hash is stored; the first 8 characters stay readable so the
 * merchant can tell its keys apart. The leader makes the first 8 characters `gsm_` plus four random ones.
 *
 * @param randomText the random part (`TokenService.random(32)`, base64url)
 * @returns the key and its display prefix
 */
export function composeApiKey(randomText: string): { readonly key: string; readonly prefix: string } {
  const key = `${API_KEY_LEADER}${randomText}`;
  return { key, prefix: key.slice(0, API_KEY_PREFIX_LENGTH) };
}

/** An API key as the merchant portal and the console read it (never the hash or the key itself). */
export interface ApiKeyWire {
  readonly id: number;
  readonly clientId: number;
  readonly name: string;
  readonly prefix: string;
  readonly allowedIps: string[];
  readonly rateLimitPerMin: number;
  readonly lastUsedAt: string | null;
  readonly lastUsedIp: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
  /** True for a key staff created for the merchant (`api_keys.created_by` is set); the portal shows "made by support". */
  readonly createdByStaff: boolean;
}

/** The columns of an `api_keys` row that the wire shows. */
export interface ApiKeyColumns {
  readonly id: number;
  readonly clientId: number;
  readonly name: string;
  readonly prefix: string;
  readonly allowedIps: readonly string[];
  readonly rateLimitPerMin: number;
  readonly lastUsedAt: Date | null;
  readonly lastUsedIp: string | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  /** The staff member who created the key; null for a key the merchant made before decision 067. */
  readonly createdBy: number | null;
}

/**
 * Writes a stored key as the wire shows it.
 *
 * Why: identity-platform-5: `allowedIps` loses the `/32` or `/128` of a single host (the formatter of the IP rules), and a key
 * that was never used has `lastUsedIp` `''` because the console types it as a non-null string. Feature 20: `createdByStaff` tells
 * the merchant that support made the key.
 *
 * @param row the stored columns
 * @returns the wire object
 */
export function apiKeyToWire(row: ApiKeyColumns): ApiKeyWire {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    prefix: row.prefix,
    allowedIps: row.allowedIps.map(cidrToWire),
    rateLimitPerMin: row.rateLimitPerMin,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: row.lastUsedIp ?? '',
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdByStaff: row.createdBy !== null,
  };
}
