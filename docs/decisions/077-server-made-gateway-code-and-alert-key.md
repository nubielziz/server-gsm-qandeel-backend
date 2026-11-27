# 077: the server makes the code of a payment method and the key of an alert rule

Status: accepted, 2026-11-27 (the owner's order of that day: reduce what staff must type in the console). Same idea as decision 074 (the code of a
service), for two more records. The console stops sending the two identifiers and records its own side of the change.

**Context.** Two typed identifiers were left in the console: the **code** of a payment method (`POST /admin/payment-gateways`) and the **key**
of an alert rule (`POST /admin/alert-rules`). Staff had no reason to choose either: the code is part of the webhook address
(`/webhooks/payments/:gateway`) and the key is only a handle for the rule. For ready-made methods the console already worked the code out
itself (`freeCode` of `gatewayPresets.ts`: the preset key, then `_2`, `_3`).

## The rule, for both routes

- **The identifier is optional in the request.** Sent, it is judged exactly as before: the same format rule, and the same refusal when taken (`422`
  on `code` for a payment method, on `key` for an alert rule; the unique index stays the last word). A blank code (`"   "`) is a typed code that
  is empty, so it is still `422` `required` on `code` (as the blank code of decision 074).
- **Left out, the server makes it, inside the create's transaction.** The stored row, the answer and the audit row (`added payment method`,
  `added alert rule`) all carry the final value; nothing outside the transaction ever sees a placeholder.
  - **Payment method:** a method made from a ready-made preset (`preset` sent and known) takes the preset's key (`vodafone_cash`); a custom
    method takes its name as an identifier.
  - **Alert rule:** the name as an identifier.
- **A text into an identifier** (`identifierFrom`, `src/common/identifier.ts`, pure and unit-tested): accents dropped and the Latin letters that
  do not decompose spelled out (`Cr\u00e9dit` is `credit`, the German double s is `ss`), lower case, every run of characters that are not a-z or 0-9
  one `_`, no `_` at either end, cut to the longest length of the identifier (with no `_` left at the cut). A name in another script (Arabic,
  Chinese) has no a-z or 0-9, so it makes the fallback; Arabic that staff type stays data and works as a name everywhere else.
  - Payment method: at most **40** characters (`GATEWAY_CODE_MAX_LENGTH`, the `{0,39}` of `GATEWAY_SLUG_PATTERN`); fallback **`method`**; the made
    code uses `_` only (a typed one may still hold `-`).
  - Alert rule: at most **41** characters, the key must start with a letter and hold at least 3 (`ALERT_KEY_PATTERN`, now the one pattern of the
    contract and the maker); a result that starts with a digit (`5xx rate`) or is shorter than 3 characters is put behind `rule_`
    (`rule_5xx_rate`, `rule_a`); fallback **`rule`**.
- **When another record already holds it:** `<identifier>_2`, `_3`, ... (`identifierAttempt`: the base is cut so that the suffix always fits the
  longest length). For a payment method that is any other method, whatever put the code there (typed, made, or a preset's key); for an alert rule
  any other rule that is not deleted (a deleted rule gives its key back, as everywhere).
- **Two creates at the same moment both succeed** and never answer `409`/`422` for an identifier nobody typed. The shared loop
  (`firstFreeIdentifier`) reads which candidates are held, then writes with `INSERT ... ON CONFLICT (...) DO NOTHING RETURNING`
  (`insertGatewayIfCodeFree`, `insertRuleIfKeyFree`; the alert rule's conflict target is its partial index, `WHERE deleted_at IS NULL`). The unique
  index decides: a transaction that finds the candidate taken by another create still in flight waits for it, sees the clash as *no row* (not an
  error, so the transaction stays usable: no savepoint) and tries the next number. Tested with six simultaneous creates of one name on both
  routes, which give six different values. Only a **typed** value can still be refused (`422`), by the same two checks as before.
- **`PATCH` is unchanged on both.** A payment method's code never changes (`422` `immutable` on `code`, it is part of the webhook address); an
  alert rule's key can still be changed by hand to one that is free. **No migration, no existing value changes.**
- **Release order: this backend before the console that stops sending them.** Until then the console keeps sending a typed value, which is judged
  as before; the other order would send a create without it to a backend that refuses it (`422`).

## Choices the lead did not name

- **The preset's key wins over the name; a sent `code` wins over both.** A custom method called "Vodafone cash" meets the preset-made
  `vodafone_cash` and takes `vodafone_cash_2` like any other clash.
- **A name that makes a code from the fallback** (`method`, `rule`) is accepted, not refused: the second one is `method_2`. The name stays what staff
  typed; only the identifier is plain.
- **No change to the routes' error codes:** nothing in `docs/contract/error-codes.md` moves.

## Consequences

- Staff never type a payment method's code or an alert rule's key; the console shows the made value (read only for the code, which cannot change).
- The webhook address of a made code is as stable as before: the code is stored once and `PATCH` still refuses to change it.
- Not changed: migrations, queues, cache keys, the other fields' validation, permissions (`payments:gateways`, `alerts:create`; the Owner-only
  rules of decision 046 run after the validation exactly as before).
