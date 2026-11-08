// Route contracts of the customer block, export and anonymization (map domain I, stage 18): the last three admin customer actions.
// Shapes are the console's (src/features/customers/types: BlockCustomerBody; privacy.ts).
import { z } from 'zod';
import { defineRoute, zIdParam } from '../../../common/contract';
import { BLOCK_REASONS, MAX_BLOCK_NOTE_LENGTH } from '../domain/customer-privacy';

/** `POST /admin/customers/:id/block`. */
export const blockCustomer = defineRoute({
  key: 'POST /admin/customers/:id/block',
  summary: 'Block or unblock a customer',
  description:
    '`{ blocked: true, reason }` blocks a customer for fraud (use suspend for a temporary stop); `{ blocked: false }` lifts the ' +
    'block (a reason is optional). Blocking sets the status `blocked` and the risk level `high`, ends every session, appends the ' +
    'reason to the internal notes, and adds to the blocklist, with source manual, the reason, the caller and the customer: the email, ' +
    'each distinct card fingerprint of their payments and each distinct IMEI still stored on their orders and checkouts (an entry ' +
    'that already exists is kept as it is and not linked to this customer). Unblocking sets `active`, moves `high` risk to ' +
    '`medium` and deletes only the manual entries this customer’s block added. `reason` must be one of: ' +
    `${BLOCK_REASONS.join('; ')} (422 on \`reason\` otherwise). Audited as \`blocked customer\` or \`unblocked customer\`.`,
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:block',
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

/** `GET /admin/customers/:id/export`. */
export const exportCustomerData = defineRoute({
  key: 'GET /admin/customers/:id/export',
  summary: 'Export a customer’s data',
  description:
    'A JSON file (`Content-Disposition: attachment; filename="customer-<id>.json"`, never cached) with everything the shop holds ' +
    'about the customer: the profile, the orders with their IMEI, the payments without card data, the consents, the checkout ' +
    'sessions, the support tickets with their public messages, the IMEI checks and the data requests. It works for an anonymized ' +
    'customer too. The export closes the customer’s open or in-progress export request (`completed`, handled by the caller) and is ' +
    'audited as `exported data of`; no copy of the file is kept. Because a GET has this side effect and carries no CSRF token, the ' +
    'request must come from the same site (`Sec-Fetch-Site: same-origin` or `same-site`, else an `Origin` that is one of the allowed ' +
    'origins): anything else is `403 CSRF_FAILED`.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:privacy',
  originCheck: true,
  params: z.object({ id: zIdParam }),
  success: { status: 200, contentType: 'application/json' },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND'],
});

/** `POST /admin/customers/:id/anonymize`. */
export const anonymizeCustomer = defineRoute({
  key: 'POST /admin/customers/:id/anonymize',
  summary: 'Anonymize a customer',
  description:
    'Irreversible. The customer becomes `anonymized`: the name is "Deleted customer", the email `deleted-<id>@redacted.invalid` (the ' +
    'old address is free again), the phone and internal notes are cleared, marketing is off and the account is closed (credentials ' +
    'deleted, every session ended, outstanding links voided). The IMEI on their orders, checkout sessions and IMEI checks is cut to ' +
    'the TAC and a mask (an IMEI check loses `imei_enc`, `imei_hash` and `cached_until` together). Payments, ledger entries and ' +
    'amounts stay for accounting. The customer’s open or in-progress erasure request is completed. Audited as `anonymised customer`, ' +
    'naming the customer by number.',
  tags: ['customers'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:privacy',
  params: z.object({ id: zIdParam }),
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'ANONYMIZED'],
});
