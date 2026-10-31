# 010: Ids and public tokens

Status: accepted, 2026-10-31.

**Context.** The frontend types every id as a JSON number (`Id = number`, frontend decision 011); `orders.id` is the
Dhru REFERENCEID (map). B2C links need unguessable tokens (tracking, checkout, tickets).

**Decision.**
- Primary keys: `bigint generated always as identity`, read as JS numbers (Drizzle `mode: 'number'`; safe below
  2^53). No UUIDs on the wire. Display ids (ORD-123, SF-123, DP-123) are frontend formatting of the number.
- Capability tokens in links (order tracking `orders.public_token`, `checkout_sessions.token`, ticket tokens):
  128-bit random, base64url (22 chars), unique index, stored as is so emails can be re-sent; lookups are rate
  limited.
- Credential tokens (sessions, invite/reset/magic-link/verify `auth_tokens`, API keys): 256-bit random, stored only
  as keyed hashes (decision 019), single use and expiry where the map says.

**Consequences.** Ids are sequential and therefore guessable: every read checks ownership or permission; nothing
public is addressed by id alone.
