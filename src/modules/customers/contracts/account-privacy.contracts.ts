// Route contracts of the account block, privacy read, export and anonymization (map domain I, stage 18; decision 064): the four admin
// routes of the customers module over the one account row. They replace the three `/admin/customers/:id` actions of the same names, which
// answer 410 now (customer-privacy.contracts.ts). Shapes are the console's (BlockCustomerBody; privacy.ts) with the account's words.
import { z } from 'zod';
import { defineRoute, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { BLOCK_REASONS, MAX_BLOCK_NOTE_LENGTH } from '../domain/customer-privacy';

/** One consent a buyer gave on a shop order: the purpose, the document it names (empty for a purpose that has none), when and from where. */
const AccountConsentSchema = z.object({
  purpose: z.string(),
  document: z
    .string()
    .describe('The document and its version, for example "Terms of service v3.2"; empty when the purpose has none.'),
  at: zIsoDateTime,
  ip: z.string(),
});

/** The privacy facts of an account: the marketing choice, the consents of its latest shop order and its risk signals. */
export const AccountPrivacySchema = z.object({
  marketingOptIn: z.boolean(),
  latestConsents: z
    .object({ orderId: zId, records: z.array(AccountConsentSchema) })
    .nullable()
    .describe('The consent evidence of the latest shop order; null for an account without one.'),
  risk: z.object({
    highestScore: z.number().int().nullable(),
    signals: z.array(z.object({ text: z.string(), orderId: zId })),
  }),
});

/** `POST /admin/clients/:id/block`. */
export const blockAccount = defineRoute({
  key: 'POST /admin/clients/:id/block',
  summary: 'Block or unblock an account',
  description:
    '`{ blocked: true, reason }` blocks an account of any rank for fraud (use a suspension for a temporary stop); `{ blocked: false }` ' +
    'lifts the block (a reason is optional). Blocking sets the status `blocked`, ends every session, stops every API key, appends the ' +
    'reason to the internal notes, and adds to the blocklist, with source manual, the reason, the caller and the account: the email, ' +
    'each distinct card fingerprint of its payments and each distinct IMEI still stored on its shop orders and checkouts (never the ' +
    'IMEIs of portal or Dhru orders: a merchant orders for other people’s devices; an entry that already exists is kept as it is and ' +
    'not linked to this account). Unblocking sets `active` and deletes only the manual entries this account’s block added. `reason` ' +
    `must be one of: ${BLOCK_REASONS.join('; ')} (422 on \`reason\` otherwise). Audited as \`blocked account\` or \`unblocked account\`.`,
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:block',
  params: z.object({ id: zIdParam }),
  body: z.object({
    blocked: z.boolean(),
    reason: z
      .string()
      .trim()
      .max(MAX_BLOCK_NOTE_LENGTH, `Use at most ${MAX_BLOCK_NOTE_LENGTH} characters.`)
      .optional()
      .describe(`When blocking, one of: ${BLOCK_REASONS.join('; ')}. When lifting, an optional note.`),
  }),
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'ALREADY_BLOCKED',
    'NOT_BLOCKED',
    'ANONYMIZED',
    'VALIDATION_FAILED',
  ],
  examples: { request: { blocked: true, reason: 'Chargeback or dispute' } },
});

/** `GET /admin/clients/:id/privacy`. */
export const readAccountPrivacy = defineRoute({
  key: 'GET /admin/clients/:id/privacy',
  summary: 'The privacy facts of an account',
  description:
    'For an account of any rank and status: `marketingOptIn`; `latestConsents`, the consent records written for its latest shop order ' +
    '(null without one), each with the document it names and the address it was given from; and `risk`, the highest score and the ' +
    'signals of its orders, newest first, at most 20.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: AccountPrivacySchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: {
    response: {
      marketingOptIn: true,
      latestConsents: {
        orderId: 4021,
        records: [
          { purpose: 'terms', document: 'Terms of service v3.2', at: '2026-10-30T14:19:19.000Z', ip: '203.0.113.24' },
          { purpose: 'withdrawal_waiver', document: '', at: '2026-10-30T14:19:22.000Z', ip: '203.0.113.24' },
        ],
      },
      risk: { highestScore: 12, signals: [{ text: 'New device', orderId: 4021 }] },
    },
  },
});

/** `GET /admin/clients/:id/export`. */
export const exportAccountData = defineRoute({
  key: 'GET /admin/clients/:id/export',
  summary: 'Export an account’s data',
  description:
    'A JSON file (`Content-Disposition: attachment; filename="account-<id>.json"`, never cached) with everything the shop holds about ' +
    'the account, of any rank: the profile with its rank (and the company, address, tax id and username when it has them), the orders ' +
    'with their IMEI, the payments without card data, the consents, the checkout sessions, the support tickets with their public messages ' +
    "(only tickets whose requester's address is confirmed: a ticket opened on the contact form with a typed address is left out until " +
    'its link is used), the data requests, the uploaded files (name and size) and, for a retail account, the store balance with its ' +
    'statement (`wallet`, staff reasons hidden). A merchant rank adds `merchant`: its wallet and statement, its API keys (label and ' +
    'dates, never a key or a hash) and its invoices. For a retail account whose email is proven, `ordersPlacedAsGuest` lists the orders, ' +
    'payments, checkouts, consents, tickets and files of the guest row of that email. It works for an anonymized account too. The export ' +
    'closes the account’s open or in-progress export request (`completed`, handled by the caller) and is audited as `exported data ' +
    'of`; no copy of the file is kept. Because a GET has this side effect and carries no CSRF token, the request must be started by the ' +
    'console itself (`Sec-Fetch-Site: same-origin`, or an `Origin` that is one of the console’s origins): anything else is ' +
    '`403 CSRF_FAILED`.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:privacy',
  originCheck: true,
  params: z.object({ id: zIdParam }),
  success: { status: 200, contentType: 'application/json' },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});

/** `POST /admin/clients/:id/anonymize`. */
export const anonymizeAccount = defineRoute({
  key: 'POST /admin/clients/:id/anonymize',
  summary: 'Anonymize an account',
  description:
    'Irreversible, and for the retail rank only (`409 CONFLICT` "Move the account to the retail rank first." for a merchant rank). The ' +
    'account becomes `anonymized`: the name is "Deleted account", the email `deleted-account-<id>@redacted.invalid` (the old address is ' +
    'free again), the phone and internal notes are cleared, marketing is off and the account is closed (the password and the two-step ' +
    'secret are cleared, every session ended, every API key stopped, outstanding links voided). The IMEI on its orders and checkout ' +
    'sessions is cut to the TAC and a mask. Payments, ledger entries and amounts stay for accounting. The account’s open or in-progress ' +
    'erasure request is completed. When the account’s email is proven, the guest row of that email is erased in the same transaction with ' +
    'the same steps (an open checkout or a pending payment of that row refuses the whole erasure with `409 CONFLICT`). Audited as ' +
    '`anonymised account`, naming the account by number. Refused with `409 CONFLICT` while the store balance is not zero, a top-up ' +
    'waits for review or a top-up dispute is open; unpaid top-ups are voided.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:privacy',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'ANONYMIZED', 'CONFLICT'],
});
