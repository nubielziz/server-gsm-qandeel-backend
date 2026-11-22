# 052: Sign-in and mail limits

Status: accepted, 2026-11-22 (feature 42). Amends decisions 021 (rate limiting) and 034 (Turnstile).

**Context.** The per-email sign-in counters used the exact client address while every other per-client limit uses the IPv4 address or the
IPv6 /64. Staff and merchant password sign-ins had no limit across addresses. The customer email lock refused every caller, the
account's owner included. The sign-in link and the forgot-password mails had no limit per recipient, and each request replaced the link
sent before. The anti-bot check of the merchant forms was off unless an operator switched it on. On the one sign-in form, a merchant
whose email was never verified took precedence over a customer account with the same email. Temporary passwords did not expire. The
forgot and registration routes did more database work for some emails than for others. The budget of authenticator codes was counted in
process memory while the cache Redis could not be reached.

**Decision.**
- Every per-email sign-in counter (sign-in, forgot password, sign-in link) is counted per email and network: the IPv4 address or the
  IPv6 /64, the key of the other per-client limits (`RequestMeta.limitKey`). Registration stays per network.
- Password sign-in attempts are also counted per email, whether or not an account has it, in two scopes: the console, and the shop
  (the merchant and customer sign-ins and the one sign-in form share one count). Every attempt is counted before its password is
  checked, in one atomic step, so attempts sent at the same moment are all counted before any is checked; a correct password takes back
  only its own count (also when a `403` follows), never the failures of other attempts, because the two shop accounts of one email may
  belong to two people (a registration proves no mailbox). After ten failures the next attempt is refused and starts a lock of 15
  minutes (the count starts again with it); the count is kept until 16 minutes pass without an attempt. While the lock runs, an attempt
  is refused with `429` and `Retry-After` (and its count goes back: it checked no password), unless it comes from a network the account
  being signed into completed a sign-in from (an IPv4 /24 or IPv6 /64 of one of its 50 newest full sessions still stored). The
  attempts such a familiar network is still allowed while the lock runs share one budget per scope, email and network
  (`sign-in-familiar`: five in 15 minutes, counted only for an attempt that is let through because of its network); when it is used
  up the attempt is refused like any other attempt on a locked email (`429`, before its password is checked, its count goes back).
  Nothing of this applies while no lock runs. A success leaves a running lock. Count and lock end with a new password from an emailed
  link (it proves the mailbox), a password or temporary password set by staff, a staff-made customer account, an anonymisation, or the
  own change of a customer or console member (those accounts exist only after a link or staff); a merchant's own or forced change does
  not end them. The answer is the same for every email. The lock lives
  on the cache Redis (`gsm:{env}:identity:sign-in-failures:{hash}`) with an in-process fallback; identity's `SignInLock` owns it and the
  customers module uses it.
- The mails a visitor can ask for (the sign-in link, forgot password) are limited per account: five an hour per kind
  (`account-mail`, kinds `sign_in_link` and `forgot_password`), apart from the mails staff send. A request beyond that answers as usual
  and sends nothing. A link from these requests keeps the two newest unused links of its family, so at most three work at once and the
  oldest goes first. Verification links and links staff send still replace the older ones; using any link still spends the others of
  its family.
- The forgot routes and registration run the same database statements for every email; when nothing may be kept the transaction is
  rolled back at its end (`DbService.runOrDiscard`). A run for an email without an account writes for an id no account has
  (`NO_ACCOUNT_ID`, a positive id that fits the bigint columns it is written to and meets no foreign key); a registration of a known
  email runs on a placeholder address. The number of password hashes does not depend on the email.
- `TURNSTILE_MERCHANT_AUTH` is on by default in production (the shop sends the token on its merchant forms) and off by default elsewhere;
  `false` switches it off.
- On the one sign-in form a merchant takes precedence over a customer account with the same email only when the merchant's email is
  verified; otherwise the merchant signs in there only when no customer account with a password has the email.
- A temporary password works for 72 hours from when it was set (`password_changed_at`); after that it is refused like a wrong password
  (and counted towards the lock). A sign-in step that is already open may finish.
- The budget of authenticator codes (`sign-in-code`: five per 15 minutes per account) is never counted in process memory: while the
  cache Redis cannot be reached the code step answers `429` with `Retry-After: 60`.
- Two-step sign-in of a merchant can be switched on only for a confirmed email address: starting an enrolment and confirming one are
  refused with `409 CONFLICT` while `email_verified_at` is empty, nothing is stored and no secret is made. The address is read under the
  merchant's row lock in the transaction that writes. Switching it off and using it at sign-in do not depend on the address. An
  address that nobody confirmed therefore never carries a second step.
- A password set from an emailed reset or invitation link on a merchant whose email is not verified also turns its two-factor sign-in
  off (the link proves the mailbox); this clears what rows from before the enrolment rule may hold.

**Consequences.** A person who signs in from a network the account never used, while the email is locked, waits for the lock to end;
customers can use the emailed sign-in link meanwhile, and staff can set a temporary password, which ends the lock.
While an email is locked, the answer to a network the account used differs from the answer to others.
A network the account used has five attempts per 15 minutes while the lock runs, and waits for the lock to end when they are used up.
A merchant whose email address is not confirmed switches two-step sign-in on only after confirming it.
Networks are remembered as long as sessions are kept (30 days after they end). While the cache Redis is down nobody can complete an authenticator step, and the other sign-in limits
count in memory per API process. A run that is rolled back consumes sequence values (id gaps). Operators keep a temporary password's 72
hours in mind; the first owner made by `bun run setup` can be removed and made again before its first sign-in. Counters keyed on exact
addresses and the old customer lock keys are abandoned at deploy and expire within 16 minutes. The owner's own failures add up across
successful sign-ins until 16 minutes pass without an attempt, so a person who mistypes often may meet the lock sooner than "ten in a
row" suggests. A merchant locked out on its shop email cannot lift the lock by changing its password; it signs in from a network it used
before, waits, or uses a reset link.
