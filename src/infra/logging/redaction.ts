// pino redaction paths, the log-object walk and the personal-data masks of decisions 012 and 054 (secrets censored, email/phone/IMEI
// masked, at any depth). Request and response bodies are never logged by default; these rules are the safety net if one ever is.
import { isSecretKey, keyWords } from '../../common/secret-keys';
import { serializeLoggedError } from './error-serializer';
import { maskEmail, maskImei, maskPhone } from './mask';

/**
 * What replaces a redacted value.
 *
 * Why: decision 012 names `[redacted]` as the replacement.
 */
export const REDACT_CENSOR = '[redacted]';

/** Headers that carry credentials (Node lower-cases header names; the capitalised forms cover hand-built objects). */
const SECRET_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-csrf-token',
  'idempotency-key',
  // The storefront's anti-bot token is single use but still a credential for five minutes (decision 034).
  'x-turnstile-token',
  // Decision 054: the other credential headers the API reads.
  'proxy-authorization',
  'x-gsm-signature',
  'stripe-signature',
  'Authorization',
  'Cookie',
] as const;

/** Body or object fields that always hold a secret, wherever they appear (up to 3 levels deep; {@link redactLogObject} applies the shared rule at any depth). */
const SECRET_FIELDS = [
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'secret',
  'apiaccesskey',
  'apiKey',
  'webhookSecret',
  'totpSecret',
  'otpauthUrl',
] as const;

/**
 * Fields that are secret only inside a request body: `code` is the 2FA code there, but `err.code` and our own
 * error `code` fields are harmless and needed for debugging.
 */
const BODY_ONLY_FIELDS = ['code'] as const;

const HEADER_HOLDERS = [
  'headers',
  'req.headers',
  'res.headers',
  'request.headers',
  'response.headers',
  '*.headers',
] as const;
const FIELD_DEPTHS = ['', '*.', '*.*.', '*.*.*.'] as const;
const BODY_HOLDERS = ['body', 'req.body', 'request.body', '*.body', '*.*.body'] as const;

/**
 * Every pino redaction path: credential headers, secret fields and body-only secrets.
 *
 * The paths are the second net: {@link redactLogObject} applies the shared secret-name rule at every depth (decision 054).
 *
 * Why: decision 012 lists `authorization`, `cookie`, `set-cookie`, `x-csrf-token`, `idempotency-key` (plus decision 034's
 * `x-turnstile-token`) and the body fields `password`, `currentPassword`, `newPassword`, `token`, `code`, `secret`,
 * `apiaccesskey`, `apiKey`, `totpSecret`, `otpauthUrl` as never loggable.
 */
export const REDACT_PATHS: readonly string[] = [
  ...HEADER_HOLDERS.flatMap((holder) => SECRET_HEADERS.map((header) => `${holder}["${header}"]`)),
  ...FIELD_DEPTHS.flatMap((depth) => SECRET_FIELDS.map((field) => `${depth}${field}`)),
  ...BODY_HOLDERS.flatMap((holder) => [...SECRET_FIELDS, ...BODY_ONLY_FIELDS].map((field) => `${holder}.${field}`)),
];

/**
 * The three personal-data masks by field name.
 *
 * Why: decision 012: personal data is masked by the logger, not by hand at each call site. Since decision 054 they are no longer
 * registered as pino serializers: {@link redactLogObject} applies them at every depth, and a second mask would turn `***567` into `***`.
 */
export const PII_SERIALIZERS = { email: maskEmail, phone: maskPhone, imei: maskImei } as const;

/** Containers deeper than this are replaced by a marker (the walk is bounded in depth). */
const MAX_WALK_DEPTH = 6;
/** The walk visits at most this many values per log line; the rest is replaced by a marker (the walk is bounded in work). */
const MAX_WALK_VISITS = 5000;
/** What replaces a part of a log object beyond the walk's bounds. */
const WALK_TRUNCATED = '[truncated]';
/** Values that stay readable under a secret-looking name: flags and the boot summary's markers. */
const READABLE_MARKERS = new Set<unknown>(['', '[set]', '[unset]', REDACT_CENSOR]);

type KeyKind = 'secret' | 'email' | 'phone' | 'imei' | 'plain';
const PII_LAST_WORDS = new Map<string, KeyKind>([
  ['email', 'email'],
  ['emails', 'email'],
  ['phone', 'phone'],
  ['phones', 'phone'],
  ['imei', 'imei'],
  ['imeis', 'imei'],
]);
const KEY_KINDS = new Map<string, KeyKind>();
const MAX_KEY_KINDS = 2000;

function kindOf(key: string): KeyKind {
  const known = KEY_KINDS.get(key);
  if (known !== undefined) return known;
  const kind: KeyKind = isSecretKey(key) ? 'secret' : (PII_LAST_WORDS.get(keyWords(key).at(-1) ?? '') ?? 'plain');
  // Keys are mostly fixed names; a bound keeps a map of generated keys from growing.
  if (KEY_KINDS.size >= MAX_KEY_KINDS) KEY_KINDS.clear();
  KEY_KINDS.set(key, kind);
  return kind;
}

function maskerOf(kind: KeyKind): ((value: unknown) => string) | undefined {
  if (kind === 'email') return maskEmail;
  if (kind === 'phone') return maskPhone;
  if (kind === 'imei') return maskImei;
  return undefined;
}

function isPlainContainer(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface WalkBudget {
  left: number;
}

function walkEntry(key: string, value: unknown, depth: number, budget: WalkBudget): unknown {
  budget.left -= 1;
  if (budget.left < 0) return WALK_TRUNCATED;
  const kind = kindOf(key);
  if (kind === 'secret') {
    const readable = value === null || value === undefined || typeof value === 'boolean' || READABLE_MARKERS.has(value);
    return readable ? value : REDACT_CENSOR;
  }
  const mask = maskerOf(kind);
  if (mask !== undefined) {
    if (typeof value === 'string' || typeof value === 'number') return mask(value);
    if (Array.isArray(value)) {
      return value.map((item: unknown) =>
        typeof item === 'string' || typeof item === 'number' ? mask(item) : walkValue(item, depth, budget),
      );
    }
  }
  return walkValue(value, depth, budget);
}

function walkValue(value: unknown, depth: number, budget: WalkBudget): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Error) return serializeLoggedError(value);
  const array = Array.isArray(value);
  if (!array && !isPlainContainer(value)) return value;
  if (depth >= MAX_WALK_DEPTH) return WALK_TRUNCATED;
  if (array) {
    const items: unknown[] = [];
    for (const item of value as unknown[]) {
      budget.left -= 1;
      if (budget.left < 0) {
        items.push(WALK_TRUNCATED);
        break;
      }
      items.push(walkValue(item, depth + 1, budget));
    }
    return items;
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    copy[key] = walkEntry(key, (value as Record<string, unknown>)[key], depth + 1, budget);
  }
  return copy;
}

/**
 * Applies the secret-name rule and the personal-data masks to a log object at every depth: pino's `formatters.log`.
 *
 * Why: decisions 012 and 054: the fixed redaction paths cover a list of names three levels deep and the masks covered top-level
 * fields only; one walk applies the shared rule ({@link isSecretKey}) and the masks wherever a field sits, and turns any nested
 * `Error` into its safe form. The walk is bounded in depth (6) and in work (5,000 values per line): what lies beyond is replaced by
 * `[truncated]`. It never throws: on a failure the object is returned as it is and pino's own redaction paths still apply.
 *
 * Rules: the top-level `err` is left to pino's `err` serializer; a key that names a secret has its value replaced by `[redacted]`
 * unless it is `null`, a boolean, empty or one of the boot summary's `[set]`/`[unset]` markers; a key whose last word is
 * `email`, `phone` or `imei` (or the plural) has its text or number masked, item by item for a list; class instances other than
 * errors (dates, buffers, requests) are kept as they are.
 *
 * @param object the object a log call passed (with the mixin merged in)
 * @returns a copy with the rules applied
 */
export function redactLogObject(object: Record<string, unknown>): Record<string, unknown> {
  try {
    const budget: WalkBudget = { left: MAX_WALK_VISITS };
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      copy[key] = key === 'err' ? object[key] : walkEntry(key, object[key], 0, budget);
    }
    return copy;
  } catch {
    // The logger must never fail because of what it was asked to write.
    return object;
  }
}
