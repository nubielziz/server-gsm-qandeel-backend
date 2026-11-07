// Route contracts of the identity verification (KYC), for staff (map routes /admin/kyc-submissions*, stage 8) and for the merchant
// portal (/client/kyc, MISMATCHES B161). The staff shapes match the console's `KycSubmission` (docs/contract/endpoints/identity.md).
import { z } from 'zod';
import { defineRoute, listQuery, zId, zIdParam, zIsoDateTime } from '../../../common/contract';
import { CLIENT_STATUSES, KYC_STATUSES, KYC_SUBMISSION_STATUSES } from '../db/schema';

const FileRefSchema = z.object({ id: zId, filename: z.string(), mime: z.string(), size: z.number().int() });

/** A verification request as the console's Verification tab shows it. */
export const KycSubmissionSchema = z.object({
  id: zId,
  clientId: zId,
  status: z.enum(KYC_SUBMISSION_STATUSES),
  fileIds: z.array(zId),
  files: z
    .array(FileRefSchema)
    .optional()
    .describe('The documents, joined from the files; open them with `GET /admin/files/:id`.'),
  reviewedAt: zIsoDateTime.nullable(),
  note: z.string().describe("The reviewer's note or the rejection reason; empty until decided."),
  createdAt: zIsoDateTime,
  client: z.object({
    id: zId,
    name: z.string(),
    email: z.string(),
    country: z.string(),
    status: z.enum(CLIENT_STATUSES),
  }),
  reviewedBy: z.object({ id: zId, name: z.string() }).nullable(),
});

const submission = {
  id: 7,
  clientId: 14,
  status: 'pending' as const,
  fileIds: [9001, 9002],
  files: [
    { id: 9001, filename: 'passport.jpg', mime: 'image/jpeg', size: 482000 },
    { id: 9002, filename: 'trade-licence.pdf', mime: 'application/pdf', size: 1240000 },
  ],
  reviewedAt: null,
  note: '',
  createdAt: '2026-11-01T09:00:00.000Z',
  client: { id: 14, name: 'Gulf Digital', email: 'ops@gulfdigital.example', country: 'AE', status: 'pending' as const },
  reviewedBy: null,
};

/** `GET /admin/kyc-submissions`. */
export const listKycSubmissions = defineRoute({
  key: 'GET /admin/kyc-submissions',
  summary: 'Verification requests',
  description: 'The verification (KYC) requests of merchants, newest first, with their documents and the merchant.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'kyc:read',
  query: listQuery({
    sorts: ['createdAt', 'id'],
    defaultSort: { field: 'createdAt', order: 'desc' },
    filters: { status: { type: 'enum', values: KYC_SUBMISSION_STATUSES }, clientId: { type: 'id', ops: ['eq'] } },
  }),
  success: { status: 200, schema: KycSubmissionSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'VALIDATION_FAILED'],
  examples: { response: [submission] },
});

/** `GET /admin/kyc-submissions/:id`. */
export const getKycSubmission = defineRoute({
  key: 'GET /admin/kyc-submissions/:id',
  summary: 'One verification request',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'kyc:read',
  params: z.object({ id: zIdParam }),
  success: { status: 200, schema: KycSubmissionSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { response: submission },
});

/** `POST /admin/kyc-submissions/:id/decide`. */
export const decideKycSubmission = defineRoute({
  key: 'POST /admin/kyc-submissions/:id/decide',
  summary: 'Approve or reject a verification request',
  description:
    'Decides a pending request: approve or reject, with a note (required for a rejection, at most 300 characters). It sets the ' +
    "request's status and the merchant's `kycStatus` to the same word and does not change the merchant's account status. A request " +
    'that was decided is `409 ALREADY_DECIDED`. Audited.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'kyc:decide',
  params: z.object({ id: zIdParam }),
  body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().optional() }),
  success: { status: 200, schema: KycSubmissionSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'ALREADY_DECIDED', 'VALIDATION_FAILED'],
  examples: {
    request: { decision: 'reject', note: 'The passport photo is unreadable.' },
    response: {
      ...submission,
      status: 'rejected',
      reviewedAt: '2026-11-01T10:00:00.000Z',
      note: 'The passport photo is unreadable.',
      reviewedBy: { id: 1, name: 'Rami K.' },
    },
  },
});

/** The merchant's own view of its verification (B161). */
export const MyKycSchema = z.object({
  status: z.enum(KYC_STATUSES).describe("The merchant's verification status: none, pending, approved or rejected."),
  submission: z
    .object({
      id: zId,
      status: z.enum(KYC_SUBMISSION_STATUSES),
      note: z.string().nullable().describe('The staff note of a rejection; null otherwise.'),
      documents: z.array(z.object({ fileId: zId, filename: z.string(), mime: z.string(), size: z.number().int() })),
      submittedAt: zIsoDateTime,
      reviewedAt: zIsoDateTime.nullable(),
    })
    .nullable()
    .describe('The latest request; null when the merchant never submitted.'),
});

const mine = {
  status: 'pending' as const,
  submission: {
    id: 7,
    status: 'pending' as const,
    note: null,
    documents: [{ fileId: 9001, filename: 'passport.jpg', mime: 'image/jpeg', size: 482000 }],
    submittedAt: '2026-11-01T09:00:00.000Z',
    reviewedAt: null,
  },
};

/** `GET /client/kyc`. */
export const getMyKyc = defineRoute({
  key: 'GET /client/kyc',
  summary: 'My verification status',
  description:
    'The verification status of the signed-in merchant and its latest request. A merchant waiting for approval may call it.',
  tags: ['merchant-account'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  success: { status: 200, schema: MyKycSchema },
  errors: ['UNAUTHORIZED'],
  examples: { response: mine },
});

/** `POST /client/kyc`. */
export const submitMyKyc = defineRoute({
  key: 'POST /client/kyc',
  summary: 'Submit verification documents',
  description:
    'Submits one to five documents the merchant uploaded (PDF, JPEG or PNG, `POST /client/files`) for review and sets its ' +
    'verification status to pending. A merchant waiting for approval may call it. `409 CONFLICT` while a request is already under ' +
    'review, `409 ALREADY_DECIDED` once verified; 422 on `fileIds` for an unknown or foreign file, a duplicate, the wrong type, none ' +
    'or more than five. A rejected merchant may submit again.',
  tags: ['merchant-account'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  body: z.object({ fileIds: z.array(zId), note: z.string().trim().optional() }),
  success: { status: 201, schema: MyKycSchema },
  errors: ['UNAUTHORIZED', 'CSRF_FAILED', 'CONFLICT', 'ALREADY_DECIDED', 'VALIDATION_FAILED'],
  examples: { request: { fileIds: [9001], note: 'Trade licence attached.' }, response: mine },
});
