// Routes of the map that the backend retired on purpose (docs/decisions/061-merchant-verification-retired.md, 062-retired-features.md,
// 067-api-keys-made-by-staff.md, 068-shop-content-trimmed.md and 072-service-options-route-retired.md). The map is read-only
// and still has their rows, so they stay in the route manifest, but no contract is built for them and no console function may call them.
// Read by route-parity.test.ts, lib/manifest-parity.ts and scripts/build-coverage.mjs; proved by test/tooling/retired-routes.test.ts.
// pending.ts keeps its own meaning (routes still owed) and stays empty: a retired route is never owed.

/** One route of the map that the backend no longer serves, and why. */
export interface RetiredRoute {
  /** The decision that retired it: the three digits of its file in `docs/decisions` (for example `061`). */
  readonly decision: string;
  /** What changed in the product, in a sentence a reader outside the team can follow. */
  readonly reason: string;
}

const VERIFICATION_RETIRED =
  'Merchant verification by documents was retired: the owner creates merchant accounts and no documents are collected.';
const SIGN_UP_RETIRED = 'Public merchant sign-up was retired: the owner creates every merchant account.';
const COMMISSIONS_RETIRED =
  'Commissions and referral links were retired: no plan is assigned, nothing accrues or pays out, and no referral code is shown.';
const REST_V1_RETIRED =
  'The REST API v1 for merchants was retired: merchants connect through the Dhru endpoint and the portal.';
const WEBHOOKS_RETIRED =
  'Outgoing webhooks to merchants were retired: merchants learn of the same events by email and in the inbox.';
const CHECKOUT_REMINDERS_RETIRED =
  'The list of abandoned checkouts and the recovery emails were retired: no reminder is sent to people who left a checkout.';
const IMEI_CHECK_RETIRED = 'The free IMEI check was retired: nobody used it and no lookup service stands behind it.';
const TELEGRAM_RETIRED = 'Telegram for merchants was retired: email and the inbox stay.';
const SURVEY_RETIRED =
  'The satisfaction survey of a ticket was retired: customers are no longer asked to rate a resolved ticket.';
const DEVICE_SESSIONS_RETIRED =
  "The merchant's list of signed-in devices was retired: a merchant signs out of every device at once, and staff end every session of a merchant.";
const API_KEY_WRITES_RETIRED =
  'Merchants no longer create, change or revoke their own API keys: staff make and manage every key in the console.';
const LANDING_GENERATOR_RETIRED =
  'The landing pages were retired: a page is a static page or a blog post, so nothing generates drafts of brand, model or network pages.';
const TAC_CATALOG_RETIRED =
  'The TAC catalogue has no admin screen any more: nobody edits it by hand; the table stays as shipped data that the risk queue reads.';
const SERVICE_OPTIONS_RETIRED =
  'The model, network and MEP lists of a service are no longer edited: the console has no Options section, and the lists already saved are only shown, never changed.';

/**
 * Manifest keys (`METHOD /path`) of map rows that are deliberately not built, each with its decision and reason.
 *
 * Why: decision 009 and docs/contract/TESTS.md: the registry must equal the manifest. A row that was owed is listed in `pending.ts`; a
 * row that the product no longer wants is listed here instead, so the gap does not read as unfinished work. Rules (checked by
 * `retiredProblems` in lib/manifest-parity.ts): a key is a row of the map (a row of `scripts/map-additions` is deleted, not listed), it is
 * not built, not pending and not called by the console, and its decision file names it in backticks (`retiredDecisionProblems`, same file);
 * `COVERAGE.md` counts these rows apart from "built of".
 */
export const RETIRED: Readonly<Record<string, RetiredRoute>> = {
  'GET /client/kyc': { decision: '061', reason: VERIFICATION_RETIRED },
  'POST /client/kyc': { decision: '061', reason: VERIFICATION_RETIRED },
  'GET /admin/kyc-submissions': { decision: '061', reason: VERIFICATION_RETIRED },
  'GET /admin/kyc-submissions/:id': { decision: '061', reason: VERIFICATION_RETIRED },
  'POST /admin/kyc-submissions/:id/decide': { decision: '061', reason: VERIFICATION_RETIRED },
  'POST /client/auth/register': { decision: '062', reason: SIGN_UP_RETIRED },
  'GET /client/referrals': { decision: '062', reason: COMMISSIONS_RETIRED },
  'GET /client/commissions': { decision: '062', reason: COMMISSIONS_RETIRED },
  'GET /admin/commission-plans': { decision: '062', reason: COMMISSIONS_RETIRED },
  'GET /admin/commission-plans/:id': { decision: '062', reason: COMMISSIONS_RETIRED },
  'POST /admin/commission-plans': { decision: '062', reason: COMMISSIONS_RETIRED },
  'PATCH /admin/commission-plans/:id': { decision: '062', reason: COMMISSIONS_RETIRED },
  'DELETE /admin/commission-plans/:id': { decision: '062', reason: COMMISSIONS_RETIRED },
  'GET /admin/commission-assignments': { decision: '062', reason: COMMISSIONS_RETIRED },
  'GET /admin/commission-assignments/:id': { decision: '062', reason: COMMISSIONS_RETIRED },
  'POST /admin/commission-assignments': { decision: '062', reason: COMMISSIONS_RETIRED },
  'PATCH /admin/commission-assignments/:id': { decision: '062', reason: COMMISSIONS_RETIRED },
  'DELETE /admin/commission-assignments/:id': { decision: '062', reason: COMMISSIONS_RETIRED },
  'GET /admin/commission-accruals': { decision: '062', reason: COMMISSIONS_RETIRED },
  'GET /admin/commission-accruals/:id': { decision: '062', reason: COMMISSIONS_RETIRED },
  'POST /admin/commission-accruals/approve': { decision: '062', reason: COMMISSIONS_RETIRED },
  'GET /v1/account': { decision: '062', reason: REST_V1_RETIRED },
  'GET /v1/services': { decision: '062', reason: REST_V1_RETIRED },
  'GET /v1/services/:id': { decision: '062', reason: REST_V1_RETIRED },
  'POST /v1/orders': { decision: '062', reason: REST_V1_RETIRED },
  'POST /v1/orders/bulk': { decision: '062', reason: REST_V1_RETIRED },
  'GET /v1/orders': { decision: '062', reason: REST_V1_RETIRED },
  'GET /v1/orders/:id': { decision: '062', reason: REST_V1_RETIRED },
  'POST /v1/orders/:id/cancel': { decision: '062', reason: REST_V1_RETIRED },
  'POST /v1/orders/:id/verify': { decision: '062', reason: REST_V1_RETIRED },
  'POST /v1/files': { decision: '062', reason: REST_V1_RETIRED },
  'GET /v1/files/:id': { decision: '062', reason: REST_V1_RETIRED },
  'GET /v1/transactions': { decision: '062', reason: REST_V1_RETIRED },
  'GET /client/webhooks': { decision: '062', reason: WEBHOOKS_RETIRED },
  'POST /client/webhooks': { decision: '062', reason: WEBHOOKS_RETIRED },
  'PATCH /client/webhooks/:id': { decision: '062', reason: WEBHOOKS_RETIRED },
  'DELETE /client/webhooks/:id': { decision: '062', reason: WEBHOOKS_RETIRED },
  'POST /client/webhooks/:id/test': { decision: '062', reason: WEBHOOKS_RETIRED },
  'GET /client/webhooks/:id/deliveries': { decision: '062', reason: WEBHOOKS_RETIRED },
  'GET /admin/webhook-deliveries': { decision: '062', reason: WEBHOOKS_RETIRED },
  'GET /admin/webhook-deliveries/:id': { decision: '062', reason: WEBHOOKS_RETIRED },
  'POST /admin/webhook-deliveries/:id/retry': { decision: '062', reason: WEBHOOKS_RETIRED },
  'EVENT order.status_changed': { decision: '062', reason: WEBHOOKS_RETIRED },
  'EVENT wallet.low_balance': { decision: '062', reason: WEBHOOKS_RETIRED },
  'EVENT invoice.paid': { decision: '062', reason: WEBHOOKS_RETIRED },
  'GET /admin/checkouts/abandoned': { decision: '062', reason: CHECKOUT_REMINDERS_RETIRED },
  'POST /admin/checkouts/recover': { decision: '062', reason: CHECKOUT_REMINDERS_RETIRED },
  'POST /store/v1/imei/check': { decision: '062', reason: IMEI_CHECK_RETIRED },
  'GET /admin/imei-checks': { decision: '062', reason: IMEI_CHECK_RETIRED },
  'GET /admin/imei-checks/:id': { decision: '062', reason: IMEI_CHECK_RETIRED },
  'POST /client/telegram/link': { decision: '062', reason: TELEGRAM_RETIRED },
  'POST /webhooks/telegram/:secret': { decision: '062', reason: TELEGRAM_RETIRED },
  'POST /store/v1/tickets/:token/csat': { decision: '062', reason: SURVEY_RETIRED },
  'GET /client/sessions': { decision: '062', reason: DEVICE_SESSIONS_RETIRED },
  'DELETE /client/sessions/:id': { decision: '062', reason: DEVICE_SESSIONS_RETIRED },
  'POST /client/api-keys': { decision: '067', reason: API_KEY_WRITES_RETIRED },
  'PATCH /client/api-keys/:id': { decision: '067', reason: API_KEY_WRITES_RETIRED },
  'DELETE /client/api-keys/:id': { decision: '067', reason: API_KEY_WRITES_RETIRED },
  'POST /admin/content-pages/generate': { decision: '068', reason: LANDING_GENERATOR_RETIRED },
  'GET /admin/tac-catalog': { decision: '068', reason: TAC_CATALOG_RETIRED },
  'GET /admin/tac-catalog/:id': { decision: '068', reason: TAC_CATALOG_RETIRED },
  'POST /admin/tac-catalog': { decision: '068', reason: TAC_CATALOG_RETIRED },
  'PATCH /admin/tac-catalog/:id': { decision: '068', reason: TAC_CATALOG_RETIRED },
  'PUT /admin/services/:id/options': { decision: '072', reason: SERVICE_OPTIONS_RETIRED },
};
