// Route contracts of the file downloads (map domain G, stage 5): `GET /admin/files/:id` for staff and `GET /client/files/:id` for
// merchants (MISMATCHES B154). Both answer `302` to a short-lived presigned link; the console renders a plain link to the first.
import { z } from 'zod';
import { defineRoute, zIdParam } from '../../../common/contract';

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
