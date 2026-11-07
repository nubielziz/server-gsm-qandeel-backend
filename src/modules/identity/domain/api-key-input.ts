// Pure rules of the merchant's own API keys (routes /client/api-keys, B155): which scopes a merchant may give a key, how the
// allowed addresses are checked and written, how a new key looks and how a stored key reads on the wire. No I/O.
import { type FieldError } from '../../../common/errors';
import { cidrToWire, normaliseCidr } from './ip-rule-input';

/** The scopes a merchant may put on a key, as the REST v1 routes and the Dhru surface need them (`dhru` is matched exactly). */
export const MERCHANT_KEY_SCOPES = ['dhru', 'account:read', 'orders:read', 'orders:write', 'services:read'] as const;

/**
 * The areas of the merchant scopes: `<area>:*` covers every action of the area (the permission grammar of decision 018).
 * `dhru` has no wildcard and `*` is never offered to a merchant, so a key cannot silently gain a route added later.
 */
const WILDCARD_AREAS: readonly string[] = [
  ...new Set(MERCHANT_KEY_SCOPES.filter((scope) => scope.includes(':')).map((scope) => scope.split(':')[0]!)),
];

/** A merchant may hold at most this many keys that are neither revoked nor expired. */
export const MAX_LIVE_KEYS = 10;
/** A key may list at most this many allowed addresses or ranges. */
export const MAX_ALLOWED_IPS = 20;
/** The per-minute limit every key a merchant creates starts with; only staff change it (B155). */
export const DEFAULT_RATE_LIMIT_PER_MIN = 60;
/** How many leading characters of the key are kept for display: decision 019 says 8. */
export const API_KEY_PREFIX_LENGTH = 8;
/** Every key starts with this text, so a leaked key is recognisable in a scan of public code. */
export const API_KEY_LEADER = 'gsm_';

/**
 * Tells why a scope cannot be put on a merchant's key.
 *
 * Why: B155: a key's scopes are a subset of the merchant scopes, and the area wildcards of the permission grammar are allowed.
 *
 * @param scope one scope as sent
 * @returns the sentence for the `scopes.N` field, or `undefined` when the scope is acceptable
 */
export function scopeProblem(scope: string): string | undefined {
  if ((MERCHANT_KEY_SCOPES as readonly string[]).includes(scope)) return undefined;
  if (scope.endsWith(':*') && WILDCARD_AREAS.includes(scope.slice(0, -2))) return undefined;
  return `Unknown scope. Use ${MERCHANT_KEY_SCOPES.join(', ')} or an area wildcard such as orders:*.`;
}

/** A checked list: the values to store, or the field errors to answer. */
export type Checked<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: FieldError[] };

/**
 * Checks the scopes of a new key.
 *
 * @param scopes the scopes as sent (trimmed by the contract)
 * @returns the scopes without repeats in the order given, or one error per refused scope (`scopes.N`)
 */
export function checkScopes(scopes: readonly string[]): Checked<string[]> {
  const errors: FieldError[] = [];
  scopes.forEach((scope, index) => {
    const message = scopeProblem(scope);
    if (message) errors.push({ field: `scopes.${index}`, code: 'invalid_scope', message });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: [...new Set(scopes)] };
}

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
  readonly scopes: string[];
  readonly allowedIps: string[];
  readonly rateLimitPerMin: number;
  readonly lastUsedAt: string | null;
  readonly lastUsedIp: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

/** The columns of an `api_keys` row that the wire shows. */
export interface ApiKeyColumns {
  readonly id: number;
  readonly clientId: number;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly allowedIps: readonly string[];
  readonly rateLimitPerMin: number;
  readonly lastUsedAt: Date | null;
  readonly lastUsedIp: string | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Writes a stored key as the wire shows it.
 *
 * Why: identity-platform-5: `allowedIps` loses the `/32` or `/128` of a single host (the formatter of the IP rules), and a key
 * that was never used has `lastUsedIp` `''` because the console types it as a non-null string.
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
    scopes: [...row.scopes],
    allowedIps: row.allowedIps.map(cidrToWire),
    rateLimitPerMin: row.rateLimitPerMin,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: row.lastUsedIp ?? '',
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
