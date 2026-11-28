# 079: sign-up with details

Status: accepted, 2026-11-28 (the owner's order of 2026-11-27: "Account creation must collect the full required info"), with the fix round
of the same day that followed the attack review of sign-up (blockers B1 and B2, should-fix S2 to S6, the guest-row note) and the lead's
design change for links opened in another browser, and the final round after the re-review (the finish needs a young session and sends a
security notice, the checkout's country rule is tested, the error catalogue is the generator's again, three more refused characters, the
finish keeps a chosen currency, one mail budget per address). Builds on decisions 007 (passwords), 018 (the sign-in steps), 019 (token hashing), 034
(Turnstile), 047 (security emails), 050 (the checkout's country), 052 (sign-in and mail limits) and 064 (one account type: the sign-in link
of the retail rank, guest rows, the asking-browser cookie). The shop's side is its decision 011; release order: **this backend before the
shop** (the review's S8: release them together, the shop right after).

**Context.** Until now the shop's sign-up page sent only an email (`POST /store/v1/auth/magic-link`) and the account was made, empty, the first
time the mailed link was opened. The owner's ruling: an account is made with an **email, a password, a first name, a last name, a country and
a phone number**, all required.

## The rules

1. **A new route makes accounts: `POST /store/v1/auth/sign-up`** (public, Turnstile, `csrf: false` like the sign-in link, `Cache-Control:
   no-store`; a route beyond the map, `scripts/map-additions/79-sign-up.mjs`). Every field is required: `email` (the shop's `EmailField`),
   `password` (1 to 1024 as sent, then `checkPasswordPolicy` with the email and the names as context: `422 WEAK_PASSWORD` on `password` with
   the policy's sentence), `firstName` and `lastName` (trimmed, 1 to 60 characters counted as code points, no control character, no line
   or paragraph separator (U+2028, U+2029) and no invisible direction mark: U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069;
   the re-review added U+061C, U+2028 and U+2029), and together, with the space, at most 120 characters, the
   limit of every account name (`MAX_NAME_LENGTH`, counted as that check counts; `422` on `lastName`), `country` (two letters, and a country
   a retail account may have, below; `422` on `country` code `unsupported`), `phone` (spaces, dashes, dots and brackets removed, then an
   optional leading `+` and 7 to 15 ASCII digits, stored in that form; tabs, line breaks and the invisible marks are not separators and are
   refused). The field rules are identity's (`domain/sign-up.ts`, re-exported for the shop's contracts by the leaf seam
   `ports/sign-up-fields.ts`). The answer is `204` for every valid body, whoever holds the email, and it sets the asking-browser cookie
   exactly as the sign-in link does. The work does not tell either: the password is hashed with argon2id **before** the email is looked up,
   in every branch, and every branch issues one link and queues one mail (or rolls back, decision 052). The budget is the sign-in link's: the
   same `sign-in` limiter key (email and network) and the same `account-mail` points (`sign_in_link`), so the two routes share five an hour.
   **One mail budget per address (the re-review):** a login account spends its own points (by its id); an address without a login account
   spends the address's points, the key of the note of rule 4 (`compositeKey('address', email, 'sign_in_link')`), whether it gets the note
   or a sign-up link of its guest row, so its notes and its sign-up links are five an hour together (counting the links by the guest row's
   id made a second budget and doubled it).
   - **An address with a login account** gets, where `requestLink` would mail its sign-in link, that link in the mail
     `customer.sign_up_existing`: "You already have an account. Nothing was changed." (a merchant rank, an account that may not act, a
     blocked email and a spent budget get nothing, as from `requestLink`). Nothing of the form is stored or applied.
   - **Any other address** (no row, or only a guest row) gets the sign-in link of its guest row (found or made) in the mail
     `customer.sign_up_link`: "Finish creating your account", with the line "If you did not ask for this, ignore this email: no account is
     made until the link is opened." The form waits beside that link in `account_signups` (identity, migration `0074_account_signups`): the
     argon2id hash, the names, the country and the phone, **one row per link** (`auth_token_id` unique, `ON DELETE CASCADE`). A newer sign-up
     for the same address deletes nothing (the review's B2: it used to delete the older form, so the older link made an account with
     nothing): each link applies its own form, and the exchange of any link of the address deletes them all.
   - **The lock (the review's S2).** A sign-up and a link request take the account row `FOR KEY SHARE`, never `FOR UPDATE`. That is enough:
     `KEY SHARE` makes the writers that take `FOR UPDATE` (the exchange, the finish, the status and rank writers) wait until the link and its
     outbox event are committed, so the row cannot change between the read that decided the mail and the commit, while two public requests
     for one address never wait for each other. Since every link keeps its own form there is nothing to serialize; the mail outbox takes the
     same lock.
   - **The three mails (the review's S3)** are identity's events, security mails of decision 047 whose texts ship with the code
     (`IDENTITY_SHIPPED_TEXT_ONLY`; no migration installs them): `customer.sign_up_link` and `customer.sign_up_existing` are sign-in links
     (`secretLink`, sent and rotated by the account mail job like `customer.magic_link`), and `customer.no_account` is the note of rule 3. Only
     the owner of the mailbox reads them. A fourth, `customer.password_set`, is the mail of rule 5's finish.
2. **The country of a retail account (the review's B1).** `src/common/countries.ts` holds the 249 officially assigned ISO 3166-1 alpha-2
   codes and `XK`, equal to the shop's `COUNTRY_CODES` (never `Intl.DisplayNames`, which names `EU`, `UN`, `UK`, `SU`, `AC`, `IC`, `QO`).
   `assertRetailCountry` (the sign-up, its finish, the staff create and edit of an account): while some tax window is in force, only their
   countries (as before); **while none is, any code of the list**. The checkout and the profile edit (`CustomerProfileRules`:
   `assertCheckoutCountry` and `assertCountryAccepted`, so `PATCH /store/v1/me`): with windows in force unchanged; with none, a code of the
   list (before: the checkout took any two letters and the profile edit refused every country). **Production has no tax rates today**: before
   this round no sign-up could have succeeded there. The checkout's side is tested (the re-review): with no window in force `ZZ` and `UK`
   are `422` on `country` (code `unsupported`) and a listed code in lower case opens; its route contract says so.
3. **The exchange (`POST /store/v1/auth/verify`) finishes the sign-up.** In its transaction, after the link is used up, the form of the link
   is taken (read and deleted) and every other waiting form of the address is deleted with it: those of the links the exchange voids and of
   any other link of the row (the review's B2 and S5); nothing with a password hash outlives the exchange. The account is made from the guest
   row exactly as before. Then `signUpOutcome` decides:
   - **this exchange made the account and the browser that sent the form opened the link** (`requestedHere`): the form is applied: `name` =
     first name, one space, last name; `country` with the shop currency it derives; `phone`; and the password, set as a password from a mailed
     link is set (`POST /client/auth/password/reset`: `password_changed_at`, no forced change, the mark of a staff-set password cleared, the
     wrong authenticator codes forgotten, the invitation and reset links voided, the account's other sessions ended before the session of this
     exchange opens, which stays, and the shop sign-in lock of the email cleared after the commit). The answer says `passwordSet: true`.
   - **this exchange made the account in any other browser**: the account is made and signed in with **nothing** of the form (no name beyond
     what the exchange gives a new account, no country, no phone, no password); the waiting hash is discarded. The answer says `passwordSet:
     false` and `pendingDetails: { firstName, lastName, country, phone }`, the details as typed, shown only to the person who proved the
     mailbox so they can confirm or correct them with the finish (rule 5). The password is never returned.
   - **a login account for the address already existed at the exchange**: the link is a plain sign-in; neither `passwordSet` nor
     `pendingDetails` is in the answer and nothing is applied.
   Every other answer of `verify` is unchanged.
4. **An emailed link no longer makes an account.** `POST /store/v1/auth/magic-link` keeps its answer, its limits and its link for a login
   account. For an address with no login account it issues no link; it mails the note `customer.no_account`: no account uses the address yet,
   and the shop's sign-up page (`<STORE_BASE_URL>/en/sign-up`). **The note is addressed to the typed email, and the request leaves no row
   behind** (the review: a guest row made only to address the note let strangers plant rows for any address). The notification code allowed
   it cleanly with one addition: `NotificationService.enqueueToEmail` writes the `notifications` row for the pseudo-recipient (`account`,
   `ADDRESS_RECIPIENT_ID` = 0) with the address in the payload's `to` (masked in the log), as the alerts use (`staff`, 0); only an event
   registered `namedAddress` takes it, and the delivery reads the address from the payload. The row and its `notification.send` outbox event
   (ids only) are written in the request's transaction and rolled back with the run when nothing may be sent: an address whose guest row is
   blocked, or that a create check refuses, gets nothing. The note's budget is the address's own (`account-mail`, key
   `compositeKey('address', email, 'sign_in_link')`, five an hour), shared with the sign-up links of the address (rule 1), one budget call
   for every such request. (A rolled-back guest row could not
   carry the note: the row it names must exist when the mail is sent.)
5. **A new route finishes a sign-up: `POST /store/v1/auth/sign-up/finish`** (`customer-session` of the retail rank, the `active` step, CSRF as
   the other session routes, `Cache-Control: no-store`, five tries per account in 15 minutes on the `sign-in` limiter, kind
   `sign-up-finish`; a route beyond the map). For a signed-in account that has **no password yet**: the account a link opened elsewhere, and
   an older account made by a link without details, which completes itself the same way. Body `{ firstName, lastName, country, phone,
   password }` with exactly the rules of the sign-up (the policy with the email and the new names). It sets the name, the country, the phone
   and the password as a password chosen by its owner is set: `password_changed_at`, no forced change, the invitation and reset links
   voided, the account's other sessions ended as a password change ends them, the present session kept. **The currency** follows the
   country only when the country differs from the account's stored one (as `PATCH /store/v1/me`): an account that confirms its country keeps
   the currency it chose, and an account with no country yet gets the currency of the new one (the re-review). An account that already has
   a password is refused with `409 CONFLICT` (the code `POST /store/v1/me/password` answers for its twin case, "no password yet"); the
   account is read again under its `FOR UPDATE` lock and the write is guarded by `password_hash IS NULL`, so a password set meanwhile wins.
   The answer is the account's own view (`AccountMe`, what `GET /store/v1/me` answers).
   - **A young session only (the re-review).** Without it any open session of an account without a password (an older account made by a
     link, a session left on a shared computer) could set a password of its choice. The finish is accepted only on a session opened at most
     60 minutes ago (`SIGN_UP_FINISH_SESSION_MAX_AGE_MS` and `signUpFinishSessionFresh`, `domain/sign-up.ts`; the session's `created_at`
     read from Postgres by `SessionService.openedAt`, judged on the injected clock, before the hash and any write). An account without a
     password can only have been signed in by a link, so a young session means the mailbox was proven minutes ago. An older session is
     `409 CONFLICT` (no catalogue code fits better: the route's other refusal's code) with the detail "For your security, finish creating
     your account within an hour of opening the sign-in link. Ask for a new sign-in link, open it and try again."; a new sign-in link opens
     a young session.
   - **The owner is told (the re-review).** In the same transaction the finish queues the security notice of decision 047 to the account's
     address: its own mail `customer.password_set` ("A password was set for your account", `MerchantLifecycleMails.passwordSet`; an identity event,
     a security mail of decision 047 whose text ships with the code, `IDENTITY_SHIPPED_TEXT_ONLY`, no migration). It is not the staff notice
     `customer.security_notice`, whose stored text says "Our support team made this change to your account": the owner of the account made
     this change. The text is "Hi {{customerName}}, {{change}} If this was you, there is nothing to do. If it was not you, ask for a sign-in
     link on the sign-in page, then change the password in your account settings, or contact our support team." with `change` the sentence "A
     password was set for your account just now, when its sign-up was finished." (a security notice keeps `{{change}}`, and only a security
     event is sent from shipped text alone); a missing or switched-off template does not stop it (its shipped text is sent).
6. **Nothing with a password hash outlives its link (the review's S5).** The exchange deletes every form of its address; the job
   `sign_up_purge` (`maintenance` queue, scheduler `sign-up-purge`, every 15 minutes, `upsertJobScheduler` through the scheduler registry, a
   `job_runs` row per run, `docs/queues.md`) deletes the forms whose link expired or was used or voided; the daily `session_purge` keeps the
   same pass as a second net; a deleted link takes its form with it.

## Why the form waits for the asking browser (the pre-hijack)

Without that rule a stranger could sign up with someone else's address and a password of their own, wait for the owner of the mailbox to
open the mailed link (which makes the account and signs the owner in), and later sign in to the owner's account with the password the
stranger chose. The link proves the mailbox, not the form: only the browser that sent the form, and so knows the password, may set it. The
review added that applying the stranger's name, phone and country is wrong too (an account that greets its owner by a stranger's name, or
sends codes to a stranger's phone), and mail apps on phones open links in their own browser, so "opened elsewhere" is common, not rare: the
account is then made with nothing of the form, and its owner confirms or corrects the details and chooses the password with the finish. The
rule is `signUpOutcome` (`domain/sign-up.ts`); the same reason is written beside it in the code. Three "other browsers" are tested: no
cookie, a browser holding its own valid asking-browser cookie from another request, and a forged cookie of the right shape; none gets the
details or the password.

## What existing links and accounts see

- **Links mailed before this release** (plain sign-in links of guest rows) keep working until their hour ends: they still make the account,
  without details; the finish completes it. Nothing is migrated: the new table starts empty, and an API of the release before never reads it.
- **Existing accounts** change nothing: a sign-up of their address mails "you already have an account" with their ordinary link and stores
  nothing; a login account still gets its sign-in link from `POST /store/v1/auth/magic-link`.
- **No plain password anywhere:** the form's password is hashed before any write; the waiting row holds the hash; no audit row is written (an
  account's own sign-in and finish are not staff writes); the outbox events and the jobs carry ids; the pino redaction censors `password` in
  any body that would be logged (decision 012), and request bodies are not logged. A test runs the app's logger at trace level into a buffer
  for a success, a `422`, a `429` and a forced `500` of the sign-up and of the finish, and finds the password text neither there nor in the
  answers, `audit_logs`, `outbox_events`, `notifications` or the mails.

## Consequences

- The shop calls `POST /store/v1/auth/sign-up` from its sign-up page, reads `passwordSet` and `pendingDetails` on its link page and calls
  `POST /store/v1/auth/sign-up/finish` from a "confirm your details" form (its decision 011); it must ship right after this backend. The
  review's B3 (the sign-up and merchant forms must be `method="post"`, the button disabled until the script loads) and S7 (the shop's e2e
  helpers that expect a link to make an account) are the shop's.
- Every place that relied on "a link makes the account" changed: the backend's own (the self sign-up of `requestLink`, the contracts, the
  READMEs, the tests); the shop's sign-in pages, its checkout and order pages that offer an account, and the handoff documents outside this
  repository (`STOREFRONT-HANDOFF.md`, `STOREFRONT-BACKEND-HANDOFF.md`) are listed for the lead.
- `docs/contract/error-codes.md` is what `bun run contract:docs` makes, with no hand-written rows (the re-review removed the route list
  the fix round had added to `scripts/build-contract-docs.mjs`): its Routes column lists the console's routes, so the `WEAK_PASSWORD` of the
  two new routes is written in their route contracts (and so in the OpenAPI document) only.
- A note to an unknown address is a `notifications` row that names no account: an erasure of an account cannot find it; the retention of
  notifications removes it like any other row.
