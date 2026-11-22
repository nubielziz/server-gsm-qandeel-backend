# Crypto (`src/infra/crypto`)

Encryption at rest, token hashing, password hashing and webhook signatures (decisions 007 and 019). Secrets come from
`AppConfig` and never leave these classes.

| What                                                  | Where                                       |
| ----------------------------------------------------- | ------------------------------------------- |
| `EncryptionService`: AES-256-GCM keyring with key ids | `encryption.service.ts`                     |
| `TokenService` (`hash`, `lookupHash`), `hashToken`, `randomToken`, `constantTimeEqual` | `token.service.ts`, `tokens.ts`   |
| `CapabilityTokenVault`: the shop's link tokens (issue, seal, hash, reveal; decision 054) | `capability-token-vault.ts` |
| `sealCapabilityTokens`: the one-off pass loop that seals the link tokens stored as issued | `capability-token-seal.ts` |
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

**Rotating a key:** Add the new key to `ENCRYPTION_KEYS`, set `ENCRYPTION_ACTIVE_KID` to it and deploy: new values use it, old ones
still decrypt under their own key id. No job re-encrypts stored values (decision 054): keep the old key for as long as values sealed by it
exist. After a suspected leak, change the secrets themselves (supplier and gateway keys, webhook secrets, 2FA enrolment): entering them
again seals them with the active key. `needsRotation` / `rotate` are building blocks for a later pass.

## Tokens

`hashToken(key, input)` is `HMAC-SHA256(key, input)` as 64 hex characters: store that, look rows up by it (unique index), never the
token. Tokens are `randomToken(bytes)` (at least 16 bytes, base64url). Compare secrets with `constantTimeEqual`. Two keys, two uses
(decision 054):

- `TokenService.hash` (`TOKEN_PEPPER`): credentials (sessions, one-time links, API keys) and short-lived limiter keys. Changing the pepper
  signs everybody out and voids every API key and open link (`docs/OPERATIONS.md` section 5).
- `TokenService.lookupHash` (`LOOKUP_HASH_KEY`; `TOKEN_PEPPER` outside production when unset): hashes stored for later matching (blocklist,
  IMEI history, inventory and open-order duplicates, unsubscribe links, Idempotency-Key requests, webhook event ids, the shop's link tokens).
  Changing it makes every stored lookup stop matching; it is never changed (`docs/OPERATIONS.md` section 5), and both processes refuse to
  start in production when it differs from the key the stored lookups were made with.

**The shop's link tokens** (checkout, order tracking, support ticket) go through `CapabilityTokenVault`: the row keeps
`lookupHash("capability:<kind>:<token>")` to be found and an AES-GCM copy to show the link again, with the column as AAD
(`checkout_sessions.token_enc`, `orders.public_token_enc`, `support_tickets.token_enc`). `reveal` reads the copy, else the plain column
of a row written before decision 054 (until the owning module's seal pass ran).

## Passwords

`PasswordHasher.hash` returns a PHC string that starts with `$argon2id$`; `verify` returns false for a wrong password and for
anything that is not a usable argon2id hash; `needsRehash` says when the cost in the config is higher than the one stored.
The cost is `ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM` (default: the OWASP baseline). **Tune it on the
host that runs the API:** `bun run bench:argon2` prints the time per hash for candidate settings (aim for 50-150 ms).

## Webhook signatures

`X-GSM-Signature: t=<unix>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>.<body>")`. `verifyWebhookSignature` checks the
signature in constant time and then the timestamp (5 minutes either way); several `v1` values are accepted so a secret can
be rotated. Verify the exact bytes of the body, not a re-serialised object.
