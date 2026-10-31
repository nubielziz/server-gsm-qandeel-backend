// Keeps secrets out of audit_logs: before/after snapshots are copied with the values of secret-looking keys replaced.
// Services pass whole row snapshots to AuditService.record; this is the net that stops a hash or a token reaching the log.

/**
 * What a redacted value is replaced with.
 *
 * Why: the console shows the diff of an audit row; a visible marker says that a secret changed without showing it.
 */
export const REDACTED = '[redacted]';

/** The last word of a key (split on case changes, `_`, `-`, `.`) that marks its value as a secret. */
const SECRET_LAST_WORDS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'hash',
  'enc',
  'credentials',
  'authorization',
  'cookie',
  'totp',
  'pepper',
]);
/** Two-word endings that mark a secret (`apiKey`, `privateKey`, `signingKey`). */
const SECRET_KEY_PREFIXES = new Set(['api', 'private', 'secret', 'signing', 'access']);

const MAX_DEPTH = 8;

function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

/**
 * Tells whether a key names a secret.
 *
 * Why: decisions 007 and 019 store credentials as hashes or encrypted text, but a snapshot of a whole row (a staff member,
 * an API key, a gateway) still carries those columns; they must never be copied into the audit log.
 *
 * @param key a property name in camelCase, snake_case or kebab-case
 * @returns true for names such as `passwordHash`, `totpSecretEnc`, `apiKey`, `token`, `authorization`
 */
export function isSecretKey(key: string): boolean {
  const words = wordsOf(key);
  const last = words.at(-1);
  if (last === undefined) return false;
  if (SECRET_LAST_WORDS.has(last)) return true;
  return last === 'key' && words.length > 1 && SECRET_KEY_PREFIXES.has(words.at(-2) ?? '');
}

function redactValue(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) return depth >= MAX_DEPTH ? REDACTED : value.map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    if (depth >= MAX_DEPTH) return REDACTED;
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // A flag such as `mustChangePassword: true` and an empty value say nothing secret; they stay readable.
      const secret =
        isSecretKey(key) && item !== null && item !== undefined && typeof item !== 'boolean' && item !== '';
      copy[key] = secret ? REDACTED : redactValue(item, depth + 1);
    }
    return copy;
  }
  return value;
}

/**
 * Copies a snapshot for the audit log with the secrets replaced by {@link REDACTED}.
 *
 * Why: see {@link isSecretKey}. Booleans, `null` and empty strings under a secret-looking key are kept (they are flags such
 * as `mustChangePassword`, not secrets). Dates and other class instances are passed through for the JSON encoder.
 *
 * @param snapshot the state of a record before or after a change
 * @returns a deep copy, nested objects and lists included, safe to store
 */
export function redactForAudit(snapshot: Record<string, unknown>): Record<string, unknown> {
  return redactValue(snapshot, 0) as Record<string, unknown>;
}
