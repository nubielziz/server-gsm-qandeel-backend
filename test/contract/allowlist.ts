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
];
