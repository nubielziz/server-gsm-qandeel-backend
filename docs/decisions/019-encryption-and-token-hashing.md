# 019: Encryption at rest and token hashing

Status: accepted, 2026-10-31.

**Decision.**
- Encrypted columns (`*_enc`: TOTP secrets, supplier and gateway credentials, `checkout_sessions.imei_enc`):
  AES-256-GCM (node:crypto), random 96-bit IV, AAD = `<table>.<column>`. Text format
  `v1:<kid>:<iv>:<tag>:<ciphertext>` (base64url parts). Keys from `ENCRYPTION_KEYS` (`kid:base64-32-bytes`, comma
  separated) with `ENCRYPTION_ACTIVE_KID`; old keys stay for decryption; a maintenance job re-encrypts to the active
  key. Keys never leave the process and are never logged.
- Credential tokens (sessions, `auth_tokens`, API keys): stored as `HMAC-SHA256(TOKEN_PEPPER, token)` hex, looked up
  by hash with a unique index, compared in constant time. API keys show a non-secret `prefix` (first 8 characters)
  for display. Passwords use argon2id (decision 007).
- Outgoing merchant webhooks are signed with HMAC-SHA256 of `<timestamp>.<body>` using the endpoint secret; incoming
  gateway webhooks are verified per gateway, rejected outside a 5-minute window and de-duplicated by the gateway
  event id (replay protection).

**Consequences.** A database dump alone reveals no usable secret or credential; rotating the pepper invalidates all
sessions and keys, so it is a planned operation.
