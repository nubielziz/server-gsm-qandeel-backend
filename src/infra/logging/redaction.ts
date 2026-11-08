// pino redaction paths and the personal-data serializers of decision 012 (secrets censored, email/phone/IMEI masked).
// Request and response bodies are never logged by default; these rules are the safety net if one ever is.
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
  // The Telegram webhook's shared secret (decision 033, B165).
  'x-telegram-bot-api-secret-token',
  'Authorization',
  'Cookie',
] as const;

/** Body or object fields that always hold a secret, wherever they appear (up to 3 levels deep). */
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
 * Why: decision 012 lists `authorization`, `cookie`, `set-cookie`, `x-csrf-token`, `idempotency-key` (plus decision 034's
 * `x-turnstile-token` and decision 033's `x-telegram-bot-api-secret-token`) and the body fields `password`, `currentPassword`, `newPassword`, `token`, `code`, `secret`,
 * `apiaccesskey`, `apiKey`, `totpSecret`, `otpauthUrl` as never loggable.
 */
export const REDACT_PATHS: readonly string[] = [
  ...HEADER_HOLDERS.flatMap((holder) => SECRET_HEADERS.map((header) => `${holder}["${header}"]`)),
  ...FIELD_DEPTHS.flatMap((depth) => SECRET_FIELDS.map((field) => `${depth}${field}`)),
  ...BODY_HOLDERS.flatMap((holder) => [...SECRET_FIELDS, ...BODY_ONLY_FIELDS].map((field) => `${holder}.${field}`)),
];

/**
 * Serializers applied to top-level log fields by name: `logger.info({ email }, '...')` logs `r***@domain`.
 *
 * Why: decision 012: personal data is masked by serializers, not by hand at each call site.
 */
export const PII_SERIALIZERS = { email: maskEmail, phone: maskPhone, imei: maskImei } as const;
