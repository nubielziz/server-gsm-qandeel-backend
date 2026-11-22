// One rule for the names that hold a secret, shared by the audit snapshots, the settings route and every log line (decision 054).

const SECRET_LAST_WORDS = new Set([
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'hash',
  'enc',
  // `credential` alone is not here: audit rows describe how an account got its credential under that key ("invite link emailed").
  'credentials',
  'authorization',
  'cookie',
  'totp',
  'pepper',
  'signature',
  'salt',
  'dsn',
  'jwt',
  'otpauth',
]);
/** Names written as one word (`apikey`) or joined from several (`secretAccessKey` reads `secretaccesskey`). */
const SECRET_JOINED = new Set([
  'apikey',
  'apiaccesskey',
  'accesskey',
  'secretkey',
  'privatekey',
  'signingkey',
  'otpauthurl',
  'recoverycodes',
  'backupcodes',
]);
/** Words before a final `key` that mark a secret (`apiKey`, `privateKey`, `encryptionKey`). */
const SECRET_KEY_PREFIXES = new Set(['api', 'private', 'secret', 'signing', 'access', 'encryption', 'webhook', 'hmac']);
/** Words before a final `code` or `codes` that mark a secret (`recoveryCodes`, `backup_code`). */
const SECRET_CODE_PREFIXES = new Set(['recovery', 'backup']);

/**
 * Splits a property name into lower-case words.
 *
 * Why: the rule reads the last words of a name, whatever its case style (decisions 007, 019, 054).
 *
 * @param key a name in camelCase, snake_case, kebab-case or dotted form
 * @returns its words in lower case; empty for an empty name
 */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

/**
 * Tells whether a key names a secret.
 *
 * Why: decisions 007, 019 and 054: one rule decides which names hold a secret, for the audit snapshots, the settings route and every
 * log line. A snapshot of a whole row (a staff member, an API key, a gateway) still carries hash and encrypted columns; they must
 * never be copied into the audit log or a log line.
 *
 * @param key a property name in camelCase, snake_case or kebab-case
 * @returns true for names such as `passwordHash`, `totpSecretEnc`, `apiKey`, `otpauthUrl`, `x-gsm-signature`, `sentryDsn`, `authorization`
 */
export function isSecretKey(key: string): boolean {
  const words = keyWords(key);
  const last = words.at(-1);
  if (last === undefined) return false;
  if (SECRET_JOINED.has(words.join('')) || SECRET_LAST_WORDS.has(last) || words.includes('otpauth')) return true;
  const previous = words.at(-2) ?? '';
  if (last === 'key') return SECRET_KEY_PREFIXES.has(previous);
  return (last === 'codes' || last === 'code') && SECRET_CODE_PREFIXES.has(previous);
}
