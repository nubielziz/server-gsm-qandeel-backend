// Accepted deviations between the backend and the frontend contract (docs/contract/TESTS.md, decision 009).
import type { AllowlistEntry } from './lib/allowlist-check';

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
      'The console types the metric as a string and offers its own list of keys; the backend owns the registry of ten keys (B101, health-commissions-13, decision 062) and answers 422 on `metric` for any other key, and OpenAPI carries the ten keys as an enum.',
  },
  {
    route: 'PATCH /admin/alert-rules/:id',
    part: 'request',
    path: 'body.metric',
    rule: 'enum',
    mismatch: 'B101',
    reason: "Same as POST /admin/alert-rules: the metric is one of the backend registry's ten keys (B101).",
  },
  {
    route: 'GET /admin/alert-rules',
    part: 'fixture',
    path: 'data[].metric',
    rule: 'fixture',
    mismatch: 'B244',
    reason:
      "Decision 062: the success rate of the retired outgoing webhooks left the metric registry, so a rule cannot use it; the console's " +
      'mock still holds one rule on it, which the harvested fixture is made of (alerts that fired with it still read).',
  },
  {
    route: 'GET /admin/notification-templates',
    part: 'response',
    path: 'data[].channel',
    rule: 'enum',
    mismatch: 'B244',
    reason:
      'Decision 062 keeps Telegram for the operations alerts: the staff templates of alert.fired, alert.resolved and ' +
      'retail.prices_followed stay on that channel. The console types a template as email only and leaves the Telegram rows out ' +
      'of its list, so it tolerates them; the lead rules whether the console shows them again.',
  },
  {
    route: 'GET /admin/notification-templates/:id',
    part: 'response',
    path: 'channel',
    rule: 'enum',
    mismatch: 'B244',
    reason: 'Same as GET /admin/notification-templates: a staff alert template may be on Telegram (decision 062).',
  },
  {
    route: 'POST /admin/notification-templates',
    part: 'response',
    path: 'channel',
    rule: 'enum',
    mismatch: 'B244',
    reason: 'Same as GET /admin/notification-templates: a staff alert template may be on Telegram (decision 062).',
  },
  {
    route: 'PATCH /admin/notification-templates/:id',
    part: 'response',
    path: 'channel',
    rule: 'enum',
    mismatch: 'B244',
    reason: 'Same as GET /admin/notification-templates: a staff alert template may be on Telegram (decision 062).',
  },
  {
    route: 'GET /admin/invoices',
    part: 'response',
    path: 'data[].kind',
    rule: 'enum',
    mismatch: 'B244',
    reason:
      'Decision 062 retires the invoice kind statement as a list filter and keeps it on the wire for the old rows that may hold it ' +
      '(nothing writes it any more). The console no longer types it and shows a kind it does not know in plain words.',
  },
  {
    route: 'GET /admin/invoices/:id',
    part: 'response',
    path: 'kind',
    rule: 'enum',
    mismatch: 'B244',
    reason: 'Same as GET /admin/invoices: an old invoice may be of kind statement (decision 062).',
  },
  {
    route: 'POST /admin/invoices',
    part: 'response',
    path: 'kind',
    rule: 'enum',
    mismatch: 'B244',
    reason:
      'Same as GET /admin/invoices: the answer is the invoice row, whose kind keeps statement for old rows (decision 062); ' +
      'a new invoice is always manual.',
  },
  {
    route: 'POST /admin/support-tickets/:id/reply',
    part: 'request',
    path: 'body.channel',
    rule: 'enum',
    mismatch: 'B244',
    reason:
      'Decision 062 retires Telegram for merchants and customers with its driver, so a reply goes by email only and a ticket lists ' +
      'only email in replyChannels. The console still types telegram for an older backend, but it offers only the channels the ' +
      'ticket lists, so it never sends it against this one.',
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
  {
    route: 'GET /admin/audit-logs',
    part: 'fixture',
    path: 'data[]',
    rule: 'fixture',
    mismatch: 'B257',
    reason:
      'Decision 064: every audit row carries `account`, the account it is about or null. The console types the field as optional and ' +
      'its mock leaves it out of the rows that are about no account, so the harvested fixture lacks it there.',
  },
  {
    route: 'GET /admin/audit-logs/:id',
    part: 'fixture',
    path: '',
    rule: 'fixture',
    mismatch: 'B257',
    reason:
      'Same as GET /admin/audit-logs: the mock leaves `account` out of a row that is about no account (decision 064).',
  },
  {
    route: 'GET /admin/clients/:id/privacy',
    part: 'fixture',
    path: 'latestConsents.records[].document',
    rule: 'fixture',
    mismatch: 'B256',
    reason:
      'Decision 064: the consent document is an empty string when the purpose has no legal document, and the console reads an empty ' +
      'string as none. The console still types the field as nullable and its mock answers null for the withdrawal waiver.',
  },
  {
    route: 'GET /admin/clients/:id/privacy',
    part: 'fixture',
    path: 'latestConsents',
    rule: 'fixture',
    mismatch: 'B256',
    reason:
      'The same null document seen from the nullable object around it: the record list is not the object the schema describes, and it ' +
      'is not null either (decision 064).',
  },
];
