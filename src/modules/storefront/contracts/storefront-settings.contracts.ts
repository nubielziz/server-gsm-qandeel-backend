// Route contract of the storefront policies (map domain H, stage 16): PATCH /admin/storefront/settings. The shape is the console's
// `StorefrontPolicies` (src/features/settings/types/storefront.ts; docs/contract/endpoints/storefront.md).
import { z } from 'zod';
import { defineRoute, zJsonObject } from '../../../common/contract';

/** The policies that have a value: five switches and three numbers, all optional. */
const Policies = z.object({
  guestCheckout: z.boolean().optional(),
  require3ds: z.boolean().optional(),
  withdrawalWaiver: z.boolean().optional(),
  autoRefundFailed: z.boolean().optional(),
  imeiPrecheck: z.boolean().optional(),
  refundHoursBeforeDispatch: z.number().int().optional(),
  abandonedMinutes: z.number().int().optional(),
  imeiRetentionDays: z.number().int().optional(),
});

/** `PATCH /admin/storefront/settings`. */
export const updateStorefrontSettings = defineRoute({
  key: 'PATCH /admin/storefront/settings',
  summary: 'Change the storefront policies',
  description:
    'A flat partial object of the eight policy keys: `guestCheckout`, `require3ds`, `withdrawalWaiver`, `autoRefundFailed` and `imeiPrecheck` ' +
    'must be JSON booleans; `refundHoursBeforeDispatch` a whole number from 0 to 72, `abandonedMinutes` from 5 to 1440 and `imeiRetentionDays` ' +
    'from 0 to 3650. Any other key is `422` on that key ("This is not a storefront setting."); so is a value that does not fit. Every changed ' +
    'key writes an audit row. The answer holds the policies that have a value after the change (the same values `GET /admin/settings` shows). ' +
    'A `require3ds` change also flips the risk rule of that name once the risk feature exists.',
  tags: ['settings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'settings:storefront',
  body: zJsonObject,
  success: { status: 200, schema: Policies },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: { guestCheckout: false },
    response: { guestCheckout: false, require3ds: true, refundHoursBeforeDispatch: 24 },
  },
});
