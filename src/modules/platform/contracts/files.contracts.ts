// Route contracts of the files (map domain G, stages 5 and 7): the downloads `GET /admin/files/:id` for staff and `GET /client/files/:id` for
// merchants (MISMATCHES B154), which answer `302` to a short-lived presigned link (the console renders a plain link to the first), and the
// merchants' uploads `POST /client/files` (portal) and `POST /v1/files` with its download `GET /v1/files/:id` (REST v1, MISMATCHES B157).
import { z } from 'zod';
import { defineRoute, zId, zIdParam, zIsoDateTime, zUploadedFile } from '../../../common/contract';

/** `GET /admin/files/:id`. */
export const openAdminFile = defineRoute({
  key: 'GET /admin/files/:id',
  summary: 'Download a file',
  description:
    'Redirects (`302`) to a presigned object-storage link that expires after 5 minutes (`Content-Disposition: attachment` with the ' +
    'stored file name, `Cache-Control: no-store`). `:id` is `orders.inputFileId`, `result.fileId` of an order or a KYC document. The ' +
    'console renders a plain link, so an error is shown raw in the new tab: the `detail` is readable.',
  tags: ['files'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'files:read',
  params: z.object({ id: zIdParam }),
  success: { status: 302 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED', 'UNAVAILABLE'],
});

/** `GET /client/files/:id`. */
export const openClientFile = defineRoute({
  key: 'GET /client/files/:id',
  summary: 'Download one of my files',
  description:
    'Redirects (`302`) to a presigned object-storage link that expires after 5 minutes (`Content-Disposition: attachment` with the ' +
    "stored file name, `Cache-Control: no-store`). The file must be the merchant's own: an upload of its own (`owner_type client`), or " +
    'the input or result file of one of its own orders. Anything else, an unknown id included, is `404` (never `403`, so ids cannot be ' +
    'probed). A merchant waiting for approval may read its own uploads (B153).',
  tags: ['files'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  params: z.object({ id: zIdParam }),
  success: { status: 302 },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'NOT_FOUND', 'VALIDATION_FAILED', 'UNAVAILABLE'],
});

/** A stored file as an upload answers it. */
const StoredFileSchema = z.object({
  id: zId.describe('What a File service order takes as its input file (`fileId`), or a KYC submission or a receipt.'),
  filename: z.string().describe('The base name of the file, without control characters, at most 200 characters.'),
  size: z.number().int().min(1).describe('Bytes.'),
  mime: z.string().describe('The media type the client declared (`application/octet-stream` when it sent none).'),
  sha256: z.string().describe('Hex SHA-256 of the content.'),
  createdAt: zIsoDateTime,
});

/** The multipart body of an upload: one part named `file`. */
const UploadBody = z.object({ file: zUploadedFile });

const UPLOAD_DESCRIPTION =
  'Uploads one file (`multipart/form-data` with one part named `file`, any media type, 1 byte to 25 MiB). The name is reduced to ' +
  'its base name without control characters (at most 200 characters). The object goes to the files bucket and a file owned by the ' +
  'merchant is recorded with its size and SHA-256. A missing or empty file is `422` on `file`; more than 25 MiB is `413`.';

const STORED_FILE_EXAMPLE = {
  id: 9001,
  filename: 'firmware.bin',
  size: 1048576,
  mime: 'application/octet-stream',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  createdAt: '2026-11-07T10:15:00.000Z',
} as const;

/** `POST /v1/files`. */
export const uploadV1File = defineRoute({
  key: 'POST /v1/files',
  summary: 'Upload a file',
  description:
    `${UPLOAD_DESCRIPTION} The id is what a File service order takes as its input file (\`fileId\` of \`POST /v1/orders\`). ` +
    'Maintenance with the order scope refuses the upload like an order. Scope `orders:write`.',
  tags: ['files'],
  surface: 'v1',
  access: 'api-key',
  permission: 'orders:write',
  bodyType: 'multipart',
  body: UploadBody,
  success: { status: 201, schema: StoredFileSchema },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'IP_NOT_ALLOWED',
    'ACCOUNT_SUSPENDED',
    'ACCOUNT_PENDING_APPROVAL',
    'RATE_LIMITED',
    'MAINTENANCE',
    'VALIDATION_FAILED',
    'PAYLOAD_TOO_LARGE',
    'UNAVAILABLE',
  ],
  examples: { response: STORED_FILE_EXAMPLE },
});

/** `GET /v1/files/:id`. */
export const openV1File = defineRoute({
  key: 'GET /v1/files/:id',
  summary: 'Download a file',
  description:
    'Redirects (`302`) to a presigned object-storage link that expires after 5 minutes (`Content-Disposition: attachment` with the ' +
    "stored file name, `Cache-Control: no-store`). The file must be the merchant's own: an upload of its own, or the input or result " +
    'file of one of its own orders. Anything else, an unknown id included, is `404` (never `403`, so ids cannot be probed). Scope ' +
    '`orders:read`.',
  tags: ['files'],
  surface: 'v1',
  access: 'api-key',
  permission: 'orders:read',
  params: z.object({ id: zIdParam }),
  success: { status: 302 },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'IP_NOT_ALLOWED',
    'ACCOUNT_SUSPENDED',
    'ACCOUNT_PENDING_APPROVAL',
    'RATE_LIMITED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'UNAVAILABLE',
  ],
});

/** `POST /client/files`. */
export const uploadClientFile = defineRoute({
  key: 'POST /client/files',
  summary: 'Upload a file',
  description:
    `${UPLOAD_DESCRIPTION} The same upload as \`POST /v1/files\`, for the merchant portal: the id is what an order, a KYC submission ` +
    'or a bank transfer receipt refers to. A merchant waiting for approval may upload (its KYC documents, B153).',
  tags: ['files'],
  surface: 'client',
  access: 'merchant-session',
  pendingMerchant: 'allow',
  bodyType: 'multipart',
  body: UploadBody,
  success: { status: 201, schema: StoredFileSchema },
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'CSRF_FAILED', 'VALIDATION_FAILED', 'PAYLOAD_TOO_LARGE', 'UNAVAILABLE'],
  examples: { response: STORED_FILE_EXAMPLE },
});
