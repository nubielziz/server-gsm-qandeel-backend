# 050: Risk inputs

Status: accepted, 2026-11-22 (feature 40). Extends the risk rules of feature 18 and decision 025 (held orders).

**Context.** The screening of a storefront payment had inputs that nothing supplied: the card's issuing country and funding, the visitor's
country, a VPN or proxy lookup and an IMEI blacklist lookup. Rules that need them were switched on by default and could never apply. The
tax country of a checkout was only the buyer's choice, and a country without a tax window was sold without tax. A guest checkout typed with
the email of an existing customer was judged with that customer's history, and an email blocked after such an order also stopped the
account. The velocity counts saw orders only, and two payments of one email screened at the same moment did not see each other. An
automatic top-up was credited when no risk screening was registered in the process.

**Decision.**
- **Inputs.** The card driver reads the card's issuing country and its funding (credit, debit, prepaid) from the charge it already reads
  the brand and the fingerprint from. A prepaid card adds its signal; the card country feeds the IP-country rule, the tax-country check and
  the country blocklist. The visitor's country is read from the header named by `GEOIP_COUNTRY_HEADER` when the checkout is opened and kept
  on the checkout (`checkout_sessions.ip_country`); without the setting it is unknown. Only a proxy in front of the edge that writes the
  header on every request may supply it: the bundled edge removes it from every request on all three hosts, and a deployment with a CDN in
  front keeps it only from the CDN (docs/OPERATIONS.md, "Visitor country").
- **Inputs without a source.** A rule or a signal whose input this installation cannot supply does not apply. At boot the API names every
  switched-on rule and every signal without a switch whose input is missing; the risk module's README lists them. The rules routes do not
  change.
- **Tax country evidence.** The card's issuing country, or the visitor's country when the card does not say, is the evidence for the
  declared tax country. When it differs, the payment is held for review with a signal that names both countries, whatever the score, as a
  review reason that comes after the payment side's own reasons; a block stays a block. The hold has no rule switch and applies only while
  the shop has at least one tax window in force (the condition of the country refusal below): with no window the declared country decides no
  tax, and the card country still feeds the score and the country blocklist. Staff approve (the declared country stands) or refund.
- **Countries without a tax window.** While at least one tax window is in force, a checkout for a country with no window in force is refused
  with the refusal the customer profile gives (`422` on `country`). A shop with no window in force sells everywhere without tax.
- **Guest checkouts.** A checkout opened without a signed-in session is a guest checkout. Its payment is judged as a first order, and it
  neither adds to nor counts against the history and the order counts of the account that owns its email; a signed-in payment is judged on
  the account's own signed-in checkouts. When staff block the email of a guest order, the card that paid the order is blocked with it; the
  email entry is limited to guest checkouts (`blocklist_entries.guest_only`) when the email belonged to an account before that order (a
  staff-made account, or an email verified before the order), so that account keeps signing in and checking out signed in and its status
  is not changed; when no account existed before the order the email is blocked everywhere, because the mailbox can become an account at any
  time. A block that staff add by hand over an entry limited to guest checkouts makes it a full entry, and so does the email block of a risk
  refund that is not itself a limited guest block (a refund of a signed-in order, or of a guest order whose email had no account before it).
  Blocking a customer account leaves a limited entry of its email as it is: the account is refused through its own status. Entries made
  any other way block everywhere, as before.
- **Velocity.** The order counts also count the buyer's other checkouts whose payment is pending or held and has no order yet (a payment
  page counts for 24 hours), read in one statement inside the payment's transaction after a transaction lock on the buyer's email, so
  payments of one email screened at the same moment see each other.
- **Top-ups fail closed.** While no risk screening is registered in a process, an automatic top-up goes to staff review with a note instead
  of being credited, and the worker logs an error at boot.

**Consequences.**
- Before the first tax window is created, create one for every country the shop sells to (a 0 % window of the type "no tax" is allowed):
  from then on a country without one is refused at checkout.
- More orders wait in the risk queue: a card or visitor country that differs from the declared country holds the order, while a tax window is
  in force. Pages opened with a guest's email count for 24 hours, so a guest who opens several payment pages can have the next payment sent
  to review (held, never refused); a signed-in account is not affected.
- A returning guest buyer is judged as a first order each time; buyers who sign in keep their history. Orders placed before this decision
  without a signed-in session count as guest orders.
- In the bundled stack `GEOIP_COUNTRY_HEADER` is set in `deploy/.env` (compose passes it to the API and to Caddy); with no CDN in front it stays
  unset and the IP-country rule has no input. With the setting on but the Caddyfile unchanged, `ip_country` stays empty and the boot check
  names no gap: the query in docs/OPERATIONS.md is the check.
- Two new columns (`checkout_sessions.ip_country`, `blocklist_entries.guest_only`). No route, response shape, error code, setting, permission,
  queue or cache key is added.
- Not part of this decision: a VPN or proxy lookup, an IMEI blacklist lookup, canonical email forms, counting failed payments, and showing in
  the console which rules lack an input, which entries are limited to guest checkouts and which orders were guest checkouts.
