// Route contract of the lookup of old merchant and customer numbers (decision 064): GET /admin/legacy-accounts/:type/:id.
import { z } from 'zod';
import { defineRoute, zId, zIdParam } from '../../../common/contract';

/**
 * `GET /admin/legacy-accounts/:type/:id`: the account an old number belongs to.
 *
 * Why: merchants kept their ids when merchants and shop customers became one account type, but every customer got a new account id, so
 * an old customer number is never an account id. Bookmarks, audit rows and history that still name an old number go through this
 * lookup, never through a guess (the console resolves every old number here).
 */
export const findLegacyAccount = defineRoute({
  key: 'GET /admin/legacy-accounts/:type/:id',
  summary: 'Find the account of an old number',
  description:
    'Reads the map of old numbers. `type` is `client` or `merchant` (an old merchant number, which is the account id of that ' +
    'merchant) or `customer` (an old shop customer number, which is never an account id). The answer is the account id, or ' +
    '`404 NOT_FOUND` for a number the map does not know and for any other `type`.',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'clients:read',
  params: z.object({ type: z.string().trim().min(1).max(32), id: zIdParam }),
  success: { status: 200, schema: z.object({ accountId: zId }) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'],
  examples: { response: { accountId: 131 } },
});
