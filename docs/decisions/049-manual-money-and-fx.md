# 049: Limits on manual money and on exchange rates

Status: accepted, 2026-11-22 (feature 39). Amends decision 029 (exchange-rate provider) and the approval rule of manual adjustments
(ANSWERS merchants Q4); extends decision 046 (actions kept for Owners).

**Context.** Several ways of putting money into a wallet rest on a person: staff adjustments, invoices issued by staff and approved by
staff, transfer receipts that staff review, and credit limits. Each was bounded one request at a time, and one receipt file could be attached
to several top-ups. Commission plans paid a share of an order's revenue whatever its margin. Card top-ups did not ask for 3-D Secure while
shop card payments did. Exchange rates were stored as the provider sent them and offered at checkout whatever their age, and a production
installation without a provider key never refreshed them. Money on the wire accepted any sign and any length; a value beyond what the
column holds ended in a server error.

**Decision.**
- **Receipts.** One transfer receipt backs at most one pending or approved top-up payment. The database refuses a second live payment with
  the same receipt file, and a receipt whose content (the SHA-256 every file row keeps) matches the receipt of a pending or approved payment,
  whoever uploaded it, is refused with `422` on `fileId` (`taken`). Uploads of the same content are judged one after another. A rejected
  payment releases its receipt. The bank reference stays optional (the receipt forms leave it out when empty) and unique per payment method.
- **Open top-ups.** A merchant holds at most five unpaid top-up invoices that are less than 24 hours old or have a receipt in review. The
  next one is `409 CONFLICT`, before any payment page is opened: the invoice is reserved first (counted and written under a per-merchant
  lock), then an automatic method's page is opened, and a gateway that fails leaves the reserved invoice void. Merchants cannot cancel a
  top-up, so an older unpaid invoice stops counting and stays payable; at most five receipts on a merchant's top-up invoices wait for review
  at a time (the next one is `409 CONFLICT`).
- **Adjustments.** The approval limit of manual adjustments caps what one staff member credits within any 24 hours, per kind of wallet
  (merchant wallets: `wallet.adjust_approval_limit`; customer balances: `wallet.customer.adjust_approval_limit`); a debit is judged on its
  own. Above the limit the adjustment is `409 APPROVAL_REQUIRED`; an Owner is not limited. A retry of an accepted adjustment with its
  `Idempotency-Key` is answered as before. Two adjustments of one staff member are judged one after the other.
- **Credit limits.** Raising a merchant's credit limit above the approval limit of merchant adjustments needs an Owner, at invitation and on
  the credit-limit route (`403 FORBIDDEN`). Lowering a limit, or sending it unchanged, never does.
- **Invoices issued by staff** record who issued them; the payment of such an invoice is approved by another staff member or by an Owner
  (`403 FORBIDDEN`). Invoices issued before this decision have no recorded issuer.
- **Money on the wire** is 0 or more with at most 14 digits before the point (what `numeric(18,4)` holds), so an out-of-range value is a
  `422` of the contract. Fields that carry signed amounts (balances, ledger lines, differences, profits and margins, figures net of refunds,
  a payment's net, supplier balances, a price before the floor) declare it and accept a minus sign; requests carry no signed money.
- **Commissions.** Together the commissions of one order never exceed its margin (revenue minus cost) when it completes; the order's own
  rebate is counted before a referral. A plan stored with a rate outside 0.5 to 15 percent accrues nothing.
- **Card top-ups** ask for 3-D Secure while the shop's `require3ds` policy is on and the method supports it, as shop card payments do; one
  rule (`asks3ds`) serves both.
- **Exchange rates.** A refreshed rate that differs from the stored one by more than `fx.max_refresh_move_percent` (default 20) is not
  stored. The move is the ratio of the larger rate to the smaller one, so a fall is judged like a rise. The stored rate stays, the currency
  is marked held, the refresh lists it in `failed` with a message that names the provider's rate, the stored rate, the move that was
  judged (the same ratio, one decimal) and the bound ("moved by 21.5 %, beyond the 20 % allowed"), the currencies page and the dashboard
  show it as stale, and the refresh that first holds it reports it once (an error log line and an error report), whether the hourly job or a staff member ran it. A
  held currency is not offered by the shop until staff enter a rate or a later refresh lands within the bound. A currency whose rate is
  older than `fx.max_rate_age_hours` (default 48) is not offered either; the base currency always is, and a checkout keeps the rate it
  locked. Both settings are bounded (1-100 percent, 1-720 hours) and are accepted by `PATCH /admin/settings`. In production, `FX_PROVIDER=openexchangerates` (the default there)
  without `FX_API_KEY` stops every process at start; `FX_PROVIDER=manual` keeps rates by hand.
- **Settings that set these limits.** `fx.max_refresh_move_percent`, `fx.max_rate_age_hours` and `wallet.customer.adjust_approval_limit` are
  changed by an Owner only: any other staff member who holds `settings:update` gets `403 FORBIDDEN` and nothing in the patch is stored
  (the `ownerOnly` mark of decision 051; the route keeps its permission).

**What it does not cover.**
- The content rule finds identical files only: a copy of a receipt whose bytes differ passes it, and the reviewer's eye stays the control.
- The rate bound is measured against the last stored rate, and the provider answer's own timestamp is not checked.

**Consequences.**
- No response shape changes; refusals use existing codes. The console shows the server's `detail`; its type has no field for a held rate,
  an invoice's issuer or a capped commission (frontend follow-ups).
- Staff need an Owner for credits beyond the daily limit, for single debits above it, for large credit limits, to approve the payment of an
  invoice they issued themselves and to change the two exchange-rate guards or the customer adjustment limit.
- A merchant whose gateway fails to open a payment page now finds a void invoice in its list instead of none.
- Commissions on thin margins are smaller than their rate times the revenue; the accrual keeps the plan's rate and the full basis.
- A shop that keeps rates by hand confirms each rate within 48 hours (entering the same number restarts its age) or raises
  `fx.max_rate_age_hours`; a development database whose rates are older than that offers only the base currency until then.
- A production installation sets `FX_API_KEY`, or `FX_PROVIDER=manual`, before this release starts.
