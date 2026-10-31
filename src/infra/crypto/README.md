# Crypto (`src/infra/crypto`)

Encryption at rest, token hashing, password hashing and webhook signatures (decisions 007 and 019). Secrets come from
`AppConfig` and never leave these classes.

| What                                                  | Where                                       |
| ----------------------------------------------------- | ------------------------------------------- |
| `EncryptionService`: AES-256-GCM keyring with key ids | `encryption.service.ts`                     |
| `TokenService`, `hashToken`, `randomToken`, `constantTimeEqual` | `token.service.ts`, `tokens.ts`   |
| `PasswordHasher`: argon2id (`@node-rs/argon2`)        | `password-hasher.ts`                        |
| `signWebhook`, `verifyWebhookSignature`, `assertWebhookSignature` | `webhook-signature.ts`           |

## Encrypted columns (`*_enc`)

```ts
const stored = this.encryption.encrypt(JSON.stringify(credentials), 'suppliers.credentials_enc');
const credentials = JSON.parse(this.encryption.decrypt(stored, 'suppliers.credentials_enc'));
```

The text is `v1:<kid>:<iv>:<tag>:<ciphertext>` (base64url parts, random 96-bit IV, 128-bit tag). The AAD is the column
(`<table>.<column>`), so a value copied into another column does not decrypt. `decrypt` throws `DecryptionError` with the
reason `malformed`, `unknown_key` or `authentication_failed`; the error never contains plaintext or key material.

**Rotating a key:** add the new key to `ENCRYPTION_KEYS` (`kid:base64`, comma separated), set `ENCRYPTION_ACTIVE_KID` to it,
deploy; old values still decrypt. A maintenance job calls `needsRotation(text)` / `rotate(text, aad)` on every `*_enc` row;
when none is left on the old key, remove it from `ENCRYPTION_KEYS`.

## Tokens

`hashToken` is `HMAC-SHA256(TOKEN_PEPPER, token)` as 64 hex characters: store that, look rows up by it (unique index), never
the token. Tokens are `randomToken(bytes)` (at least 16 bytes, base64url). Compare secrets with `constantTimeEqual`.
Rotating `TOKEN_PEPPER` invalidates every stored session and key.

## Passwords

`PasswordHasher.hash` returns a PHC string that starts with `$argon2id$`; `verify` returns false for a wrong password and for
anything that is not a usable argon2id hash; `needsRehash` says when the cost in the config is higher than the one stored.
The cost is `ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM` (default: the OWASP baseline). **Tune it on the
host that runs the API:** `bun run bench:argon2` prints the time per hash for candidate settings (aim for 50-150 ms).

## Webhook signatures

`X-GSM-Signature: t=<unix>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>.<body>")`. `verifyWebhookSignature` checks the
signature in constant time and then the timestamp (5 minutes either way); several `v1` values are accepted so a secret can
be rotated. Verify the exact bytes of the body, not a re-serialised object.
