// Accepted deviations between the backend and the frontend contract (docs/contract/TESTS.md, decision 009).
import type { AllowlistEntry } from './lib/allowlist-check';

/**
 * The reason of the four B148 entries below (`Customer.currency` may be null).
 *
 * Why: `customers.currency` is a foreign key to `currencies`, so a code that is not in the table cannot be stored. The wire id is null
 * only when the column itself is null, or when the USD row the country rule falls back to is missing (lead resolution b2c-1).
 */
const CUSTOMER_CURRENCY_NULL =
  'The console types Customer.currency as an id; it is null only for a customer whose currency column is null, or when the USD row ' +
  'of the currencies table is missing (customers.currency is a foreign key), as lead resolution b2c-1 says.';

/**
 * The reason of the three B229 entries below (the listing rows say whether the retail price follows a rule).
 *
 * Why: feature 31 (decision 040) adds `retailPriceSource`, `retailPriceRule` and `retailPriceWaiting` to every listing row, always
 * sent; the console's ServiceListing type learns them in slice C1, so until then its mock rows, which the harvested fixtures are
 * made of, lack them.
 */
const LISTING_RETAIL_SOURCE =
  'Feature 31 (decision 040, B229): every listing row says whether its retail price follows a rule (retailPriceSource, ' +
  "retailPriceRule, retailPriceWaiting); the console's ServiceListing type does not declare them yet (slice C1), so its mock " +
  'rows, which the harvested fixture is made of, lack them.';

/**
 * The reason of the two B231 entries below (a Quick add run says whether it also publishes).
 *
 * Why: feature 31 (decision 040) adds `publish` (`none`, `listed` or `unlisted`) to every Quick add run, always sent; the console's
 * QuickAddRun type learns it in slice C4, so until then its mock runs, which the harvested fixtures are made of, lack it.
 */
const QUICK_ADD_PUBLISH =
  'Feature 31 (decision 040, B231): every Quick add run says whether it also puts what it creates on the shop (publish); the ' +
  "console's QuickAddRun type does not declare it yet (slice C4), so its mock runs, which the harvested fixture is made of, lack it.";

/**
 * Deviations the contract tests accept, each tied to a decision in docs/contract/MISMATCHES.md.
 *
 * Why: the frontend decides the wire format and the map decides the rules; where the lead chose otherwise the choice
 * is a B-entry, and this list is the only place a test is told to accept it. An entry whose B-id does not exist, or that
 * no longer matches a real deviation, fails the build, so the list cannot rot. Add an entry only after the B-entry
 * exists; see test/contract/README.md.
 *
 * @example
 * { route: 'GET /admin/orders', part: 'response', path: 'data[].status', rule: 'enum', mismatch: 'B16',
 *   reason: 'The backend adds needs_attention until the console learns the status.' }
 */
export const ALLOWLIST: readonly AllowlistEntry[] = [
  {
    route: 'POST /admin/service-listings/:id/image',
    part: 'request',
    path: 'body',
    rule: 'required',
    mismatch: 'B184',
    reason:
      'Feature 22: the picture upload is a multipart body (one part `file`); the console builds a FormData from a File, which the contract extractor cannot see as a typed body.',
  },
  {
    route: 'POST /admin/payment-gateways/:id/logo',
    part: 'request',
    path: 'body',
    rule: 'unconstrained',
    mismatch: 'B232',
    reason:
      'Feature 32: the logo upload is a multipart body (one part `file`); the console passes a FormData, which the contract extractor ' +
      'cannot see as a typed body (the same case as the listing picture, B184).',
  },
  {
    route: 'GET /admin/permissions',
    part: 'fixture',
    path: '[]',
    rule: 'fixture',
    mismatch: 'B8',
    reason:
      "The backend answers [{key, label, group}] (ANSWERS access Q4, the console's Permission type); the console's mock answers " +
      'plain strings, which the console normalises. Roles and permissions come from the server; the mock is only a seed (B8).',
  },
  {
    route: 'POST /admin/alert-rules',
    part: 'request',
    path: 'body.metric',
    rule: 'enum',
    mismatch: 'B101',
    reason:
      'The console types the metric as a string and offers 11 keys; the backend owns the registry (B101, health-commissions-13) and answers 422 on `metric` for any other key, and OpenAPI carries the 11 keys as an enum.',
  },
  {
    route: 'PATCH /admin/alert-rules/:id',
    part: 'request',
    path: 'body.metric',
    rule: 'enum',
    mismatch: 'B101',
    reason: "Same as POST /admin/alert-rules: the metric is one of the backend registry's 11 keys (B101).",
  },
  {
    route: 'GET /admin/customers',
    part: 'response',
    path: 'data[].currency',
    rule: 'nullable',
    mismatch: 'B148',
    reason: CUSTOMER_CURRENCY_NULL,
  },
  {
    route: 'GET /admin/customers/:id',
    part: 'response',
    path: 'currency',
    rule: 'nullable',
    mismatch: 'B148',
    reason: CUSTOMER_CURRENCY_NULL,
  },
  {
    route: 'POST /admin/customers',
    part: 'response',
    path: 'currency',
    rule: 'nullable',
    mismatch: 'B148',
    reason: CUSTOMER_CURRENCY_NULL,
  },
  {
    route: 'PATCH /admin/customers/:id',
    part: 'response',
    path: 'currency',
    rule: 'nullable',
    mismatch: 'B148',
    reason: CUSTOMER_CURRENCY_NULL,
  },
  {
    route: 'GET /admin/content-pages',
    part: 'fixture',
    path: 'data[]',
    rule: 'fixture',
    mismatch: 'B171',
    reason:
      "The admin content page row carries `canonicalUrl` (ANSWERS storefront Q8: the row sends the page's canonical address so the " +
      "console can offer 'Open the page' again); the console's ContentPage type does not declare it yet, so its mock rows, which " +
      'the harvested fixture is made of, lack it.',
  },
  {
    route: 'GET /admin/content-pages/:id',
    part: 'fixture',
    path: '',
    rule: 'fixture',
    mismatch: 'B171',
    reason:
      "The admin content page row carries `canonicalUrl` (ANSWERS storefront Q8: the row sends the page's canonical address so the " +
      "console can offer 'Open the page' again); the console's ContentPage type does not declare it yet, so its mock rows, which " +
      'the harvested fixture is made of, lack it.',
  },
  {
    route: 'POST /admin/content-pages',
    part: 'fixture',
    path: '',
    rule: 'fixture',
    mismatch: 'B171',
    reason:
      "The admin content page row carries `canonicalUrl` (ANSWERS storefront Q8: the row sends the page's canonical address so the " +
      "console can offer 'Open the page' again); the console's ContentPage type does not declare it yet, so its mock rows, which " +
      'the harvested fixture is made of, lack it.',
  },
  {
    route: 'PATCH /admin/content-pages/:id',
    part: 'fixture',
    path: '',
    rule: 'fixture',
    mismatch: 'B171',
    reason:
      "The admin content page row carries `canonicalUrl` (ANSWERS storefront Q8: the row sends the page's canonical address so the " +
      "console can offer 'Open the page' again); the console's ContentPage type does not declare it yet, so its mock rows, which " +
      'the harvested fixture is made of, lack it.',
  },
  {
    route: 'POST /admin/content-pages/:id/publish',
    part: 'fixture',
    path: '',
    rule: 'fixture',
    mismatch: 'B171',
    reason:
      "The admin content page row carries `canonicalUrl` (ANSWERS storefront Q8: the row sends the page's canonical address so the " +
      "console can offer 'Open the page' again); the console's ContentPage type does not declare it yet, so its mock rows, which " +
      'the harvested fixture is made of, lack it.',
  },
  {
    route: 'POST /admin/content-pages/generate',
    part: 'fixture',
    path: 'created[]',
    rule: 'fixture',
    mismatch: 'B171',
    reason:
      "The drafts the generator answers are admin content page rows and carry `canonicalUrl` (ANSWERS storefront Q8); the console's " +
      'ContentPage type does not declare it yet, so its mock rows, which the harvested fixture is made of, lack it.',
  },
  ...(
    [
      ['GET /admin/service-listings', 'data[]'],
      ['GET /admin/service-listings/:id', ''],
      ['POST /admin/service-listings', ''],
    ] as const
  ).map(([route, path]): AllowlistEntry => ({
    route,
    part: 'fixture',
    path,
    rule: 'fixture',
    mismatch: 'B229',
    reason: LISTING_RETAIL_SOURCE,
  })),
  ...(['POST /admin/suppliers/:id/quick-add', 'GET /admin/suppliers/:id/quick-add/:runId'] as const).map(
    (route): AllowlistEntry => ({
      route,
      part: 'fixture',
      path: '',
      rule: 'fixture',
      mismatch: 'B231',
      reason: QUICK_ADD_PUBLISH,
    }),
  ),
];
