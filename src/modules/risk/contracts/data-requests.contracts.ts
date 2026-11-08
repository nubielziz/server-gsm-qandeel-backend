// Route contracts of the data-subject requests (map domain K, stage 18, RESOLUTIONS b2c-13): the customer asks from the storefront
// account, staff list and move the requests. Shapes are the console's (src/features/customers/types: DataRequest).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { DATA_REQUEST_KINDS, DATA_REQUEST_STATUSES } from '../db/schema';
import { MAX_REQUEST_NOTE_LENGTH, MOVE_TARGETS } from '../domain/data-requests';

/** One request as the staff list shows it. */
export const DataRequestSchema = z.object({
  id: zId,
  customerId: zId,
  kind: z.enum(DATA_REQUEST_KINDS),
  status: z.enum(DATA_REQUEST_STATUSES),
  requestedAt: zIsoDateTime,
  dueAt: zIsoDateTime.describe('The legal deadline: 30 days after the request.'),
  completedAt: zIsoDateTime.nullable().describe('Set only when the request was completed.'),
  handledBy: zId.nullable().describe('The staff member who last moved it.'),
  fileId: zId.nullable().describe('The stored export file, when there is one.'),
  createdAt: zIsoDateTime,
  customerName: z.string().describe('The customer’s current name; "Deleted customer" after anonymization.'),
});

const REQUEST_EXAMPLE = {
  id: 3,
  customerId: 12,
  kind: 'export',
  status: 'open',
  requestedAt: '2026-11-06T09:00:00.000Z',
  dueAt: '2026-12-06T09:00:00.000Z',
  completedAt: null,
  handledBy: null,
  fileId: null,
  createdAt: '2026-11-06T09:00:00.000Z',
  customerName: 'Omar Haddad',
} as const;

/** `GET /admin/data-requests`. */
export const listDataRequests = defineRoute({
  key: 'GET /admin/data-requests',
  summary: 'Data export and erasure requests',
  description:
    'Requests customers made for a copy of their data or its erasure, with the legal deadline. Filters: `status` (repeat the key for ' +
    'IN), `kind`, `customerId`. Sort by `requestedAt`, `dueAt` (default, soonest first) or `status` (in lifecycle order: open, in ' +
    'progress, completed, rejected). `customerName` is joined from the customer.',
  tags: ['data-requests'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:privacy',
  query: listQuery({
    sorts: ['requestedAt', 'dueAt', 'status'],
    defaultSort: { field: 'dueAt', order: 'asc' },
    filters: {
      status: { type: 'enum', values: DATA_REQUEST_STATUSES },
      kind: { type: 'enum', values: DATA_REQUEST_KINDS },
      customerId: { type: 'id' },
    },
  }),
  success: { status: 200, schema: DataRequestSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [REQUEST_EXAMPLE] },
});

/** `GET /admin/data-requests/:id`. */
export const getDataRequest = defineRoute({
  key: 'GET /admin/data-requests/:id',
  summary: 'One data request',
  description: 'The same row as the list. `:id` is the number after `DSR-`.',
  tags: ['data-requests'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:privacy',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: DataRequestSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: REQUEST_EXAMPLE },
});

/** `PATCH /admin/data-requests/:id`. */
export const updateDataRequest = defineRoute({
  key: 'PATCH /admin/data-requests/:id',
  summary: 'Move a data request',
  description:
    'Moves a request: open to `in_progress`, `completed` or `rejected`; `in_progress` to `completed` or `rejected`. Every move sets ' +
    '`handledBy`; `completed` sets `completedAt`. A rejection needs a non-blank `note` (at most 300 characters); the note is stored ' +
    'on the request and in the audit row. A completed or rejected request is `409 REQUEST_CLOSED`. An erasure request cannot be ' +
    'completed by hand until the customer is anonymized (`409 ERASURE_NOT_DONE`): anonymizing closes it. An unknown status is `422` ' +
    'on `status`. Audited.',
  tags: ['data-requests'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'customers:privacy',
  params: z.object({ id: zIdParam }),
  body: z.object({
    status: z.enum(MOVE_TARGETS),
    note: z
      .string()
      .trim()
      .max(MAX_REQUEST_NOTE_LENGTH, `Use at most ${MAX_REQUEST_NOTE_LENGTH} characters.`)
      .optional(),
  }),
  success: { status: 200, schema: DataRequestSchema },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'REQUEST_CLOSED',
    'ERASURE_NOT_DONE',
    'VALIDATION_FAILED',
  ],
  examples: {
    request: { status: 'rejected', note: 'We could not verify the requester.' },
    response: { ...REQUEST_EXAMPLE, status: 'rejected', handledBy: 1 },
  },
});

/** What the customer’s own request answers. */
export const MyDataRequestSchema = z.object({
  id: zId,
  kind: z.enum(DATA_REQUEST_KINDS),
  status: z.enum(DATA_REQUEST_STATUSES),
  requestedAt: zIsoDateTime,
  dueAt: zIsoDateTime.describe('The date the shop must answer by.'),
});

const MY_REQUEST_EXAMPLE = {
  id: 3,
  kind: 'export',
  status: 'open',
  requestedAt: '2026-11-06T09:00:00.000Z',
  dueAt: '2026-12-06T09:00:00.000Z',
} as const;

/** `POST /store/v1/me/data-export`. */
export const requestMyDataExport = defineRoute({
  key: 'POST /store/v1/me/data-export',
  summary: 'Ask for a copy of my data',
  description:
    'Records a request for an export of everything the shop holds about the signed-in customer. Staff answer it within 30 days. ' +
    'Asking again while an export request is still waiting returns that request instead of making a second one. Never cached.',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  success: { status: 201, schema: MyDataRequestSchema },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'CSRF_FAILED'],
  examples: { response: MY_REQUEST_EXAMPLE },
});

/** `POST /store/v1/me/data-delete`. */
export const requestMyDataErasure = defineRoute({
  key: 'POST /store/v1/me/data-delete',
  summary: 'Ask to be anonymized',
  description:
    'Records a request to anonymize the signed-in customer: name, email and IMEI numbers go; payment records stay for accounting. ' +
    'Staff carry it out within 30 days (anonymizing the customer closes the request). Asking again while an erasure request is ' +
    'still waiting returns that request. Never cached.',
  tags: ['account'],
  surface: 'store',
  access: 'customer-session',
  success: { status: 201, schema: MyDataRequestSchema },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'CSRF_FAILED'],
  examples: { response: { ...MY_REQUEST_EXAMPLE, id: 4, kind: 'erasure' } },
});
