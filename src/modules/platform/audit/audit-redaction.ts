// Keeps secrets out of audit_logs: before/after snapshots are copied with the values of secret-looking keys replaced.
// Services pass whole row snapshots to AuditService.record; this is the net that stops a hash or a token reaching the log.
// The rule that names a secret lives in src/common/secret-keys.ts (decision 054) and is re-exported here.
import { isSecretKey } from '../../../common/secret-keys';

export { isSecretKey } from '../../../common/secret-keys';

/**
 * What a redacted value is replaced with.
 *
 * Why: the console shows the diff of an audit row; a visible marker says that a secret changed without showing it.
 */
export const REDACTED = '[redacted]';

const MAX_DEPTH = 8;

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
