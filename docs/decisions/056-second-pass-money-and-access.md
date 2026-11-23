# 056: A second pass over money and access

Status: proposed (2026-11-23) on the branch `security/deep-financial-auth-fixes`; it is accepted when the owner merges that branch.
Builds on decisions 018, 037 and 044 to 055.

**Context.** After decisions 044 to 055 the money paths (orders, the ledger, payments, refunds, disputes, tax, exchange rates, supplier
costs) and the sign-in and permission code (staff, merchants, customers, API keys, sessions, files) were read once more, each rule
followed along every path that reaches it. Some rules were stated but did not hold on one path, some were judged one action at a time
where they are meant as a sum, and some were missing. This decision records the rule that each change set; the commits carry the reason
and the tests. Where a rule extends an earlier decision, that decision is named.

**Decision: money.**
- **The pattern of a field keyed imei judges the IMEI that is stored and sent.** On the portal, REST v1 and the Dhru surface the typed
  IMEI is the value the pattern of a field keyed imei judges; an input of the same key never stands in for it, and the stored input
  shows the typed IMEI. A refused IMEI answers 422 on inputs.imei (Dhru: its format error), nothing is held and no order is made.
- **A top-up through a card method is an amount the card page can charge exactly.** Where a merchant or a customer opens a top-up
  through an automatic method whose driver states the decimals it charges, an amount with more decimals is refused with 422 on amount
  before an invoice is reserved or the gateway is asked. Manual methods take the amount as typed.
- **A completion after a new supplier charge books that supplier cost.** A completion after a reopen books the cost again only for a new
  supplier charge. A cost counts as booked when no supplier acceptance was recorded since the last settlement that booked one; a reply
  by hand with no new acceptance still books revenue only.
- **Every price floor is built on a cost in the base currency from a supplier that can be used.** A supplier is saved only in the base
  currency (422 on currency otherwise), and a sync stores no prices when the supplier's account reports another currency than the stored
  one (the supplier is answered as unavailable, with both currencies named for staff). The effective cost comes from the first link that
  can really be used (the link is on, its supplier is active and still lists the service), the dispatcher's own rule; with none usable
  it keeps the highest cost of the links that are on. A change of a supplier's status recomputes the cost of its services and moves the
  price version.
- **A country taxed by region asks the checkout for a region that has a window.** (The shape of the country rule of decision 050.) A
  region is stored and compared trimmed and in upper case. While a country has at least one regional window in force, a checkout for it
  must name a region that has a window in force (422 on region otherwise; a region without tax gets a 0 % window). The one-window rule
  sees every spelling of a region as one. The region stays the buyer's own statement: nothing checks it against other evidence.
- **A chargeback gives back what an undelivered sale had booked, an inquiry opens no dispute, and every dispute of a payment decides its
  status.**
  - A chargeback of a rejected order debits the customer funds and the VAT of the disputed share (less what earlier chargebacks of the
    payment gave back); only the fee and what is left are a loss. A delivered order stays a plain loss. The VAT and payments reports
    follow the ledger lines.
  - An inquiry is acknowledged and records nothing. When the same dispute later arrives with a real status, in an update or a
    funds-withdrawn event, it is opened then, once.
  - After a dispute ends, the payment is charged back while any of its disputes is lost, disputed while another is open, and otherwise
    what its refunds say.
- **The routes that remember a merchant's listed prices answer only a request started from the portal.** The list and show routes refuse
  a request the browser marks as started by another site (Sec-Fetch-Site other than same-origin or none) unless its Origin is a shop
  origin; a request without those headers, as the portal's own server sends, is answered as before. The price export keeps the stricter
  origin rule of decision 045. A refusal is 403 CSRF_FAILED and records nothing. The contract helper learns this second mode of the
  origin check for session GET routes.
- **A storefront order is not released or sent to a supplier while its payment is disputed, charged back or refunded in full.** For a
  storefront order whose payment is disputed, charged back or refunded in full, the release from the risk review, a staff send and a
  change of supplier with a send answer 409 INVALID_TRANSITION with a sentence that names the reason; the dispatch job makes no supplier
  call and moves the order to needs_attention with a review line in order_events. After a dispute is won the order can be released and
  sent again. Merchant orders are not affected.
- **A pasted bulk reply completes only the order it was meant for.** A line is applied only when exactly one open order matches its
  input and no other order with that input, of another buyer or another service, is open or was cancelled or rejected in the last 7
  days; otherwise the line is ambiguous and nothing is applied (staff reply on the order itself). The preview names the merchant or
  customer and the service of the order a line will complete (additive response fields).
- **A customer is not anonymized while an order paid from the store balance, or a refund to it, is still open.** The erasure is refused
  with 409 CONFLICT, naming the order or the refund, while an order paid from the store balance is not final or a refund of a balance
  payment is requested or processing. The orders module answers which of the customer's balance-paid orders are open through its
  storefront port; no module reads another's tables.
- **What one staff member can create without an Owner is summed over 24 hours, credit limits and transfer approvals included.**
  (Extending decision 049.)
  - For a staff member who is not an Owner, the raised part of every credit limit they set (at an invitation too) counts with their
    credit adjustments in one 24-hour sum against wallet.adjust_approval_limit, judged under that staff member's lock. A lowering counts
    nothing.
  - A non-owner's approvals of transfer receipts on merchant-made or customer-made top-ups are summed over 24 hours against the new
    Owner-only setting wallet.receipt_approval_limit (same default); above it the approval answers 409 APPROVAL_REQUIRED and an Owner
    approves.
  - A credit-limit change locks the merchant's row, so it and a group move wait for each other.
  - A refusal that names an amount shows every decimal that is not zero.
- **The storefront checkout judges the typed IMEI and sells only what is still on sale.** At a checkout the typed IMEI is the value the
  pattern of a field keyed imei judges, and it satisfies that field when it is required. Both pay steps refuse a service that is no
  longer on sale with 409 INVALID_TRANSITION before a payment row is written or a gateway is asked; money that already arrived is still
  captured, and the answer of an earlier pay call is still replayed.
- **The VAT report keeps a filed month as it was, and the profit report counts a sale net of what was taken back.** The VAT report shows
  each period's own signed movements: a refund stays in the month it was booked and its reversal appears in the month of the reversal.
  The profit report's revenue of a delivered storefront order is its price less what refunds and chargebacks of the order's own payment
  took back, never below zero; a second payment of the same checkout and its refund or chargeback are not part of the sale.
- **A typed exchange rate far from the stored or the provider's rate needs an Owner, and a receipt states what was charged.** (Extending
  decision 049.) For a staff member who is not an Owner, a typed rate more than fx.max_refresh_move_percent away from the stored rate,
  or from the provider's rate when the provider can be asked, answers 403 and stores nothing; the same holds for the first rate of a new
  currency against the provider's rate. A change of decimals needs currencies:update. A receipt's amount and total are the payment's own
  charged amount and currency.
- **A refund settles on what the gateway really did, also after a chargeback and after a send that got no answer.**
  - A failure that arrives for a refund whose payment is charged back closes the refund and reverses its journal, exactly as the close
    at the chargeback does. A refund of a disputed or charged-back payment that the gateway holds is not sent again.
  - A send without a definite answer is remembered (refunds.unanswered_send_at). A success the gateway reports for that attempt
    completes the refund; a definite refusal of that attempt moves the send key on, so a later success of the refused attempt changes
    nothing and a retry is sent under a new key. Until one of them arrives, a retry is refused for the time the gateway remembers a key,
    with a sentence that tells staff to check the gateway.
  - The give-up leaves a refund alone when a gateway refund id is stored by the time it holds the lock.
  - The payment's status is written under the payment's lock when a refund completes.
- **An order of a charged-back payment that ends rejected gives back what the sale booked, and staff cannot complete it meanwhile.**
  - When an order of a charged-back payment ends rejected (by staff, by its supplier or by a risk refund), no refund request is opened.
    One journal per order (key order:<id>:chargeback-return) gives back the customer funds and VAT of the disputed share against the
    loss, less what the chargeback journals already gave back; a dispute lost later counts that journal, so nothing is given back twice.
    The payments and VAT reports follow the lines.
  - Accept, reply and each line of the bulk reply are refused with 409 INVALID_TRANSITION while the order's payment is disputed, charged
    back or refunded in full; a reject stays allowed, and a supplier that already has the order still completes or rejects it. An order
    reopened after a chargeback can be rejected again.
- **The proof of a bank transfer is the payer's own upload, and its reference is kept in one form and released when a claim is
  rejected.**
  - The receipt of a top-up (merchant and customer routes) must be a file its owner uploaded; a document the system stored is refused
    with 422 on fileId.
  - For manual methods a bank reference is stored and compared in one form: compatibility forms folded, digits of any script read as
    digits, white space, dashes and invisible characters dropped, upper case. What is left must be printable ASCII; anything else is
    refused with 422 on reference. A pending or approved claim keeps the reference; a rejected claim releases it.
- **A refund reversed after a chargeback leaves the books as the chargeback rules say.** When a refund of a charged-back payment is
  closed and reversed after the loss was booked, the same transaction books the give-back the chargeback rules ask for, for an order
  that was never delivered (the journal keyed per order, which counts what was already given back and posts nothing when nothing is
  left). A delivered order keeps the plain loss.

**Decision: sign-in and permissions.**
- **A temporary password that staff set for a customer is told to the customer and ends their sessions.** Setting a temporary password
  for a customer, and creating a customer account with one, writes the customer's security notice in the same transaction, with a fixed
  phrase for each case, and always ends the customer's sessions.
- **Widening a merchant key needs an Owner and is told to the merchant.** (Extending decision 046.) On `PATCH /admin/api-keys/:id` a
  staff member who is not an Owner may narrow a key (fewer addresses, a first restriction on an open key, a lower limit) but not widen
  it: an empty address list on a restricted key, an address that is not stored, or a higher rate limit answers 403 and writes nothing; a
  mixed change counts as widening. Every change of a value of a merchant key by staff mails the merchant a security notice in the same
  transaction.
- **The files host does not log the name of a downloaded file.** (Extending decision 054.) Caddy's access log writes the
  `response-content-*` values of a signed file link as `[redacted]` in the address and in the Referer, and does not write the answer
  header `Content-Disposition` on any host.
- **A change of a role ends the open streams of its members.** (Extending decision 037.) A change of a role's permissions ends the open
  `/admin/stream` connections of its members with `bye` `reauth`, so the reconnect is judged on the new permissions; a rename, or the
  same permissions sent again, ends nothing.
- **The session list shows a caller only what their permissions cover.** (Extending decisions 046 and 047.) In `GET /admin/sessions` a
  caller who is not an Owner reads `•••` for the address and the device of an Owner's session and of a member whose role holds a
  permission the caller lacks; a merchant's email is masked for a caller without `clients:read`. Ending a merchant's session needs
  `clients:security`.
- **A shop sign-in link is tied to the browser that asked for it, or says whose account it opened.** `POST /store/v1/auth/magic-link`
  marks the asking browser with an HttpOnly cookie that lives as long as the link, and the link stores a keyed hash of it
  (`auth_tokens.browser_hash`). `POST /store/v1/auth/verify` answers `requestedHere` and `maskedEmail`. A link that was not asked for in
  this browser is refused with 409 CONFLICT while the browser holds a live session of another customer (that session lives and the link
  stays usable); otherwise it signs in and says that it was asked for elsewhere.
- **An order placed as a guest with the email of an account does not speak for that account.** A ticket opened with the tracking link of
  a guest checkout whose customer has an account is filed unconfirmed (no token in the answer, not in the account's list, a note for
  staff) until the link mailed to the account's address is opened. A receipt shows the account's stored name only when the account
  opened the checkout signed in. The tracking, checkout and ticket links of an anonymized customer answer as unknown links.
- **A REST key reads the files of its merchant's orders, not every file the merchant owns.** `GET /v1/files/:id` opens an input or
  result file of the merchant's own orders and an upload that no record uses; a file that a KYC submission, a payment receipt, a ticket
  message, dispute evidence, an invoice or a data export uses answers 404 to a key. The portal session route is unchanged.
- **One person cannot stand in for two staff members, and a changed staff email voids the links sent to the old one.** (Extending
  decisions 046 and 049.) The money rules of decision 049 count per staff member, so only an Owner adds a member whose role grants
  `wallet:adjust`, `wallet:credit_limit`, `payments:approve` or `invoices:create`, gives such a role to another member, adds one of
  those permissions to a role that members hold, sets a temporary password for another member who holds one, or changes that member's
  email. Any change of a staff member's email voids the member's unused invitation and reset links.
- **The authenticator step of a sign-in has a total bound over 24 hours.** The wrong codes of an account are counted in a window of 24
  hours that starts with the first counted wrong code, and a success does not reset the count. At 20 the code step closes for the rest
  of that window and then opens again by itself with a count of zero; a password set by a link or by staff, or a 2FA reset by staff,
  opens it sooner. The 429 of a closed step states the real seconds left. Every wrong code writes one warn line with the account and the
  client address, never the code, and a closing writes one audit row.
- **A merchant credential that staff set cannot make keys or webhook secrets, and a sign-in is judged on the account as it is.**
  - A merchant account carries a mark while its password was set by staff, and one while its email was set by staff. The first is
    cleared only when the merchant chooses a password from a link mailed to its address. While a mark holds, the account's portal
    sessions cannot create or rotate an API key and cannot create, change or reveal the secret of a webhook endpoint (403 with a
    sentence that says what to do); the rest of the portal works.
  - A key a merchant makes in the portal sends the merchant the same security notice a staff-made key sends.
  - A merchant session is opened inside a transaction that reads the account again and requires the password that was verified, the same
    two-step and must-change state and a status that may sign in; a hash upgrade is written only under that check.
- **A merchant registration is proven by its mailbox and its password holder together.** The request and the answer of the verification
  stay as they are. With a full session of that same merchant (and its CSRF token) it works as before. Without one, the address is still
  marked verified, and in the same transaction the password is ended, two-step sign-in is switched off, every session of the account
  ends and the password link is mailed to the address, so only the owner of the mailbox can choose a password. A sign-in or a password
  change that was checked before that moment is refused when it lands after it; a sign-in whose stored hash was only upgraded meanwhile
  still opens.
- **An Owner's change of a merchant's email sets no hold on keys, and an Owner lifts one by confirming the address.** The mark means
  that the address was last set by a staff member who is not an Owner and that no Owner has confirmed it since. An Owner's change of the
  address writes no mark and clears one. An Owner's details edit that carries the stored address (the console sends the whole form)
  clears a set mark and changes nothing else of the email: no mail, no voided link, no ended session, no limiter point; its audit row
  records the mark going from set to cleared. The same edit by a member who is not an Owner, or an Owner's edit without the email,
  leaves the mark. The mark of a password set by staff is untouched.
- **A used-up budget of failed lookups does not shut out a live session or a valid key.** (Extending decision 053.) While an address is
  over its budget, a credential is looked up in the cache only. A view found there is served through the usual checks; anything else is
  429 without a database read and without a charge, so wrong credentials still cost nothing. The views of sessions and API keys are
  loaded again shortly before they stop being fresh and stay readable for 60 seconds after it on that path only, the once-a-minute
  last-use write replaces a view without deleting it first, and a new session's view is cached when the session is created, so a
  credential used at least every 90 seconds stays served and a sign-in from such an address finishes. A revoke still deletes the view at
  once. A credential unused for longer, or made during that time, waits until the budget opens again.
- **The hold on machine credentials also covers connecting a Telegram chat, and the notice of a portal-made key says who made it.**
  - POST /client/telegram/link runs the same check as the key and webhook routes, under the merchant's row lock and before a link token
    is voided or written: 403 FORBIDDEN with the hold's sentence while a mark is set, nothing written. The update webhook, the
    preferences and a chat connected before stay as they are. Both sentences of the hold now name Telegram.
  - A key made in the portal sends its own notice (event merchant.portal_api_key_created, sent from its shipped text): it says the key
    was created in the portal and what to do if the merchant did not create it. A key staff make keeps the notice of a staff action.

**Migrations.** `0056_tax_region_upper_case` (data only: stored regions trimmed and in upper case), `0057_credit_limit_raises` (new
table), `0058_refund_unanswered_send` (`refunds.unanswered_send_at`), `0059_receipt_reference_release` (the unique index of a payment's
gateway reference becomes partial, so a rejected claim frees its reference), `0060_link_browser` (`auth_tokens.browser_hash`),
`0061_totp_failure_cap` (three columns on `staff_users` and on `clients`) and `0062_client_set_by_staff` (two marks on `clients`). All
are additive except the data rewrite of 0056 and the index of 0059; code from before this decision runs against them.

**What differs from the map.** The ledger lines of a chargeback of an order that was never delivered (customer funds and VAT are given
back, only the fee and the rest are a loss), the matching rule of the bulk reply, and the refusals listed in the entries B234 to B239 of
`docs/contract/MISMATCHES.md`, which wait for the confirmation of the owner. The console and the storefront were not changed: the
storefront needs a region field at checkout (only once a regional tax window exists) and a notice for a sign-in link that was asked for
elsewhere; the console needs a field for `wallet.receipt_approval_limit` and can show the new refusal sentences as they are.

**Left as it is, on purpose.** The region of a checkout stays the buyer's own statement. A guest checkout typed with the email of an
account is still filed under that account (it no longer speaks for it). A partial dispute still closes every unsent refund of the
payment in full. A credential that was not used for about two minutes, or was made during that time, waits while its address is over the
failed-lookup budget. An Owner who saves a merchant's details form confirms an address that a staff member set. These are business
choices that the owner may change.
