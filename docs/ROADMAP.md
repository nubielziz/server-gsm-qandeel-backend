# Roadmap: what comes after the console port

Written 2026-11-09, after P4b. Nothing here is built yet. Each phase becomes a feature brief in `docs/briefs/` when it starts,
and goes through the usual flow (Sonnet builds, Opus reviews, full check, lead merge). Order matters: phase 0 unblocks
merchants today, phase 1 to 3 build the one public site (with 2W, the customers' wallet, before phase 2 goes live), phase 4 and
5 are needed before real customers pay. **Owner's choice
(2026-11-09): phase 0 later; the website (phases 1 to 3) first**, in `/home/saifi/gsm-project/storefront` (the owner's Next.js
scaffold and designs), from the handoff file `/home/saifi/gsm-project/STOREFRONT-HANDOFF.md`.

## Status (2026-11-11): backend and console work done; what is left is the owner's

Built, reviewed and merged on `main` in the job of 2026-11-10/11 (plans by Fable 5.2 in `docs/briefs/`, reviews by Opus and, for
money, Fable; site changes for the storefront session in `/home/saifi/gsm-project/STOREFRONT-BACKEND-HANDOFF.md`):

| Phase / item | State | Commit (backend) |
|---|---|---|
| 0.1-0.6 merchant management (plus the owner's list: forced password change, profile and business info, suspension hardening, lifecycle mails, staff mails with `CONSOLE_BASE_URL`, staff-made API keys, the console's merchant page) | **done** | `1087d98` (console `5e844ab`) |
| 1.3 smart sign-in; 1.4/1.7 Turnstile on merchant register, login, forgot (behind `TURNSTILE_MERCHANT_AUTH`) | **done** | `dc747c0` |
| 2W customer wallet (2W.1-2W.5; 2W.6 is the site's; 2W.7 is the owner's legal and accounting check: the switch `wallet.customer.enabled` stays off until then) | **done** | `796eeab` (console `faed3fb`) |
| Storefront catalog needs (`storefront/docs/BACKEND-NEEDS.md` 1-8, page list, slug alternates, help vote) | **done** | `430cf59` (console `de1b819`) |
| Notification center (broadcasts, in-app inbox on three surfaces, scheduling, Arabic) | **done** | `620eea7` (console `1011fd7`) |
| Site API gaps: Idempotency-Key on portal orders, customer profile edit | **done** | `8a501b0` |
| Phase 4 payments: Stripe defects, three-decimal currencies, two webhook secrets, the console secret fields | **done** (the provider choice stays the owner's) | `d4c7ce5` (console `dbb33fb`) |
| Phase 5: Dockerfile, production compose, Caddy, env template, backups and restore drill, Sentry | **done** (accounts, DNS, backup storage, key custody: owner checklists in `docs/OPERATIONS.md`) | `e28683b` |
| Phase 5: Arabic in PDFs | **done** | `4c20d45` |
| Phases 1-3 (the site itself) | the storefront session's work | handoff |
| Still the owner's: payment provider (Stripe via a UAE/US entity or a local driver), mail domain (SPF, DKIM, DMARC), Sentry account, backup bucket and key holders, JoFotara, the wallet's legal sign-off, data-export delivery, customer self-service email change, orderable model/network/MEP options | open | |

The sections below are the original plan (2026-11-09), kept as written.

## Decisions taken by the owner (2026-11-09)

1. **One public site for merchants and regular customers** (the "storefront"), instead of a separate merchant portal and
   storefront. The admin console stays a separate app for staff only.
2. **Two account types on the same site.** A merchant is a `clients` row (`/client/*` routes, cookie
   `__Host-gsm_client_session`), a regular customer is a `customers` row (`/store/v1/*` routes, cookie
   `__Host-gsm_store_session`). They are not merged: wallets, groups, prices and the ledger stay as they are.
3. **One smart sign-in form.** One email + password form; the site finds out which kind of account it is and opens the right
   area. Needs one new backend route (phase 1, item 1.3).
4. **The whole merchant portal lives inside the site** (all 51 `/client/*` routes): prices, orders from the wallet, top-ups,
   invoices and statement, API keys, webhooks, 2FA, settings.
5. **Arabic and English**, with a language switch; Arabic is right-to-left.
6. **Customers get a wallet too, like merchants** (decided 2026-11-09): a regular customer tops up a balance ("Add Funds") and
   pays orders from it, as the owner's checkout design shows. Not built: see **phase 2W**. The two account types stay apart, so
   a merchant's wallet and a customer's wallet are separate even for one person.

## Phase 0: manage merchants from the console (small; unblocks merchants now)

Today staff can only list merchants, create one (with an invitation), approve / suspend / reactivate, change the group, set the
credit limit, adjust the wallet and read the statement and API keys (`/admin/clients*`, 9 routes). Staff cannot change a merchant's
details, password or 2FA, while they can for a storefront customer (`/admin/customers/:id`, `/password`, `/sessions/revoke`).
A merchant cannot set a password or create an API key without the portal, so a new merchant is stuck.

| # | Item | Backend | Console |
|---|---|---|---|
| 0.1 | **Send a password reset link** to a merchant | `POST /admin/clients/:id/password` (like `/admin/customers/:id/password`): mails `merchant.password_reset` with a fresh token; audit "sent a password reset to" | "Send reset link" on the merchant page |
| 0.2 | **Resend the invitation** of a merchant who never set a password | same route with `mode: invite`, or `POST /admin/clients/:id/invite`; old tokens die | "Resend invitation" while the merchant has no password |
| 0.3 | **Edit a merchant's details**: name, company, phone, country, email | `PATCH /admin/clients/:id` grows these fields (or a new `/profile` route); an email change re-verifies and checks uniqueness; audit before/after | "Edit details" dialog |
| 0.4 | **Reset a merchant's 2FA** (lost phone) and **end their sessions** | `POST /admin/clients/:id/2fa/reset`, `POST /admin/clients/:id/sessions/revoke` | Two actions on the merchant's Security tab |
| 0.5 | **Staff invitations and resets by email** (today the token is made and thrown away: `staff-admin.service.ts` ~180 and ~292) | a staff mail event + a `CONSOLE_BASE_URL` variable for `<console>/set-password?token=`; the console already has the page | none, or a "link sent" message |
| 0.6 | *Optional, decide first:* **create an API key for a merchant** from the console (shown once to staff) | `POST /admin/clients/:id/api-keys` | "New key" on the API access tab |

Every item: permission `clients:update` (0.6 maybe a new one), one audit row, tests, the console's mismatch log, B-entry.

## Phase 1: the site's foundation

| # | Item | Notes |
|---|---|---|
| 1.1 | **New app** `storefront/` next to `frontend-admin/` | Lead's choice to confirm at the start: Next.js (server-rendered pages for search engines: services, help, pages) or Vite + React like the console (simpler, no SEO). Same HTTP rules as the console (one `fetch` client, problem+json errors) |
| 1.2 | **Arabic + English, right-to-left** | `dir="rtl"` for Arabic, a switch, language saved in a cookie and, for a signed-in customer, through `PATCH /store/v1/me` |
| 1.3 | **One smart sign-in** (backend) | New route, for example `POST /auth/sign-in`: checks the email against merchants then customers, verifies the password with the same lockout and rate limits, opens the right session and answers `{ kind: 'merchant' | 'customer', next }` (merchant 2FA step as today). It must not reveal whether an email exists. An email present in both tables: the merchant wins, and the customer area is reachable with a separate customer sign-in link. Customers without a password keep the magic link (`/store/v1/auth/magic-link`) |
| 1.4 | **Sign up** | "Create an account" (customer: magic link) and "Apply as a merchant" (`POST /client/auth/register`: pending until staff approve, email verification) |
| 1.5 | **Email links on one domain** | Both kinds use `/set-password?token=`. No code change: set `PORTAL_BASE_URL=https://<site>/merchant` and `STORE_BASE_URL=https://<site>`, so merchant links go to `/merchant/set-password`, `/merchant/verify-email` |
| 1.6 | **Public pages** | Home, services list and service page (`/store/v1/services`, `/:slug`), IMEI check (`/store/v1/imei/check`), help (`/store/v1/help`), content pages (`/store/v1/pages/:slug`), site settings (`/store/v1/config`). A signed-in merchant sees their own prices (`/client/services`) instead of retail |
| 1.7 | **Turnstile** on sign-up, sign-in, IMEI check, checkout and tickets | Site key in the app's build settings; the backend already checks the token |
| 1.8 | **Hosting on one domain** | `shop.` (site), `admin.` (console), `api.` (API); `CORS_ORIGINS`, `CSRF_COOKIE_DOMAIN` and `TRUST_PROXY` set for them (cookies are SameSite=Lax) |

## Phase 2W: a wallet for customers (decided 2026-11-09; backend first, before phase 2 goes live)

Today a storefront customer has no balance: a checkout pays one order through a gateway, the money sits in the single system
account `customer_funds` until delivery (`b2c_pay`, `b2c_deliver` in `src/modules/money/domain/money-events.ts`), and the
database allows `client_wallet` / `client_hold` only for merchants (`ledger_accounts_kind_owner_check`). A customer wallet is
therefore real money work (decision 024 rules apply: one entry point, append-only, idempotency key per move, accounts locked in id
order). The design below is the lead's starting point, to settle in the phase's brief.

| # | Item | Notes |
|---|---|---|
| 2W.1 | **Ledger accounts** | Per customer, opened on first use: `customer_wallet` (liability, the balance) and, if orders hold money like B2B, `customer_hold`; owner type `customer` (already in `LEDGER_OWNER_TYPES`). Migration: the kind list and `ledger_accounts_kind_owner_check`. No overdraft for customers. The nightly integrity job covers them |
| 2W.2 | **Money events** | `customer_topup`: Dr `gateway_clearing` (or `bank` for a manual gateway) / Cr `customer_wallet` (fee as for merchants, `fee_income`). `b2c_wallet_pay`: Dr `customer_wallet` / Cr `customer_funds` net + `vat_payable` VAT, so delivery (`b2c_deliver`) and VAT stay as today; VAT is charged when the balance pays an order, not at the top-up (stored value; confirm with the accountant). Refund of a wallet-paid order: back to the wallet (reverse entry). A balance refund to the card or bank: a policy decision (default: not offered, staff adjust by hand) |
| 2W.3 | **Customer routes** | `GET /store/v1/me/wallet` (balance, currency, limits), `GET /store/v1/me/wallet/statement` (paged, date range), `POST /store/v1/me/wallet/top-ups` (amount + payment method: opens a top-up payment through a gateway, credited by its webhook, or a manual one with a receipt like merchant invoices), and paying a checkout from the balance: a new pay method named **`balance`** (not `wallet`: `method: wallet` already means a gateway method type, `checkout-pay.contracts.ts:52`). Only a signed-in customer has a wallet (a guest checkout cannot use it). Top-up and balance pay go through the risk screening hooks like merchant top-ups |
| 2W.4 | **Rules to decide** | Minimum and maximum top-up, maximum balance, which gateways may top up (manual bank/CliQ first), what happens when a top-up is charged back (the balance may go negative: lock the wallet), dormant balances, the display currency (the ledger stays USD; the site converts with the FX rates) |
| 2W.5 | **Console (staff)** | A Wallet tab on the customer page like the merchant's: balance, statement, adjust (`GET /admin/customers/:id/wallet`, `POST /admin/customers/:id/wallet/adjust`, audited), and customer top-ups in the payments/invoices lists |
| 2W.6 | **Site** | "Add Funds", the balance in the header and checkout, the statement page, for customers as for merchants (merchants keep `/client/wallet` and `/client/invoices`) |
| 2W.7 | **Legal and payments** | A stored-value wallet may need the Central Bank of Jordan's view (keep it closed-loop: usable only for this store's services, no cash-out); Stripe restricts stored value and virtual credits, so top-ups by card may be refused: start with manual bank/CliQ top-ups. Ask a lawyer and the accountant before going live |

Size: large (ledger migration, money events with their tests and the scenario e2e tests, routes, console tab, site pages). Spec
decisions go to B-entries as usual.

## Phase 2: the customer area

Checkout (`/store/v1/checkout-sessions*`: open, consents, pay), order tracking and tax receipt (`/store/v1/orders/:token*`), my
account (`/store/v1/me*`: orders, password, language and currency, data export and deletion), support tickets
(`/store/v1/tickets*`, rating). **Card payment depends on phase 4; paying from the balance and "Add Funds" depend on phase 2W.**

## Phase 3: the merchant area (all `/client/*` routes)

| Page | Routes |
|---|---|
| Dashboard | `GET /client/dashboard` |
| Catalog with my prices, place orders (IMEI, server, file upload) | `/client/services*`, `POST /client/orders`, `POST /client/files`, `GET /client/prices/export` |
| Orders | `GET /client/orders`, `/:id`, cancel, verify, CSV export |
| Wallet and statement | `GET /client/wallet`, `/wallet/statement` |
| Top-ups and invoices (bank transfer receipt upload) | `/client/invoices*`, `GET /client/payment-methods` |
| API keys and the Dhru / REST v1 connection details | `/client/api-keys*` |
| Webhooks with delivery log and test | `/client/webhooks*` |
| Security: password, 2FA, sessions | `/client/security/*`, `/client/sessions*` |
| Profile, notification preferences, Telegram | `PATCH /client/profile`, `/client/notification-preferences`, `POST /client/telegram/link` |
| Verification (KYC upload) | `/client/kyc` |
| Referrals and commissions | `GET /client/referrals`, `GET /client/commissions` |
| Sign-in pieces | `/client/auth/*` (2FA step, verify email, forgot and reset password, sign out, me) |

## Phase 4: payments (decide before phase 2 goes live)

- **Stripe is not available to a company in Jordan** (UAE is the only Middle East country). Either a UAE or US company opens it,
  or a new driver for a local gateway (HyperPay, PayTabs, MEPS) replaces it. Unlocking services are a restricted category for
  Stripe: ask them first.
- If Stripe is kept, fix the 4 gaps found on 2026-11-09: the console has no field for the webhook secret (`whsec_…`); payments and
  disputes need two webhook secrets but a gateway stores one; the card driver waits for `refund.succeeded`, which Stripe does not
  send (`refund.updated`); card brand and last 4 are read from the wrong Stripe object.
- The crypto driver cannot be used as is (custom protocol, no `apiBase` setting), and Jordan's 2025 law needs a central bank
  authorization: leave it off.
- Merchant top-ups by bank transfer / CliQ (manual gateway) already work.

## Phase 5: production readiness

- Deployment files: backend Dockerfile, a production compose (API, worker, Postgres, two Redis, Caddy), the site's and the
  console's builds, environment templates for production.
- Backups: nightly Postgres dump to separate object storage, a copy of the files bucket, the encryption keys kept offline.
- Error tracking: wire the Sentry SDK (today `SENTRY_DSN` does nothing) or remove the variable.
- Arabic in PDFs (invoices, receipts): the PDF code has Latin fonts only.
- Jordan e-invoicing (JoFotara) if the company is registered in Jordan: check with an accountant; the backend does not connect.
- Mail: a verified sending domain in Resend (today only `onboarding@resend.dev` to the account's own address works), SPF, DKIM
  and DMARC. This network blocks plain SMTP on 587: use `smtps://…:465`.

## Until phase 0: reset a merchant's password by hand (development)

The routes are public; the merchant's email arrives through the configured mail provider.

```bash
# 1. Send the reset email (the link in it is <PORTAL_BASE_URL>/set-password?token=...).
curl -s -X POST http://localhost:3000/client/auth/password/forgot -H 'Content-Type: application/json' \
  -d '{"email":"merchant@example.com"}'
# 2. Copy the token from the link (an invitation link works too) and choose the password.
curl -s -X POST http://localhost:3000/client/auth/password/reset -H 'Content-Type: application/json' \
  -d '{"token":"<token from the link>","password":"<at least 10 characters>"}'
```

The merchant can then sign in only through the API (`POST /client/auth/login`), not through a page, until phase 3.
