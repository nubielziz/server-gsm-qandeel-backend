// Route contract of the storefront policies (map domain H, stage 16): PATCH /admin/storefront/settings. The shape is the console's
// `StorefrontPolicies` (src/features/settings/types/storefront.ts; docs/contract/endpoints/storefront.md).
import { z } from 'zod';
import { defineRoute, zJsonObject } from '../../../common/contract';

/** The policies that have a value: four switches and one number, all optional. */
const Policies = z.object({
  guestCheckout: z.boolean().optional(),
  require3ds: z.boolean().optional(),
  withdrawalWaiver: z.boolean().optional(),
  autoRefundFailed: z.boolean().optional(),
  refundHoursBeforeDispatch: z.number().int().optional(),
});

/** `PATCH /admin/storefront/settings`. */
export const updateStorefrontSettings = defineRoute({
  key: 'PATCH /admin/storefront/settings',
  summary: 'Change the storefront policies',
  description:
    'A flat partial object of the five policy keys: `guestCheckout`, `require3ds`, `withdrawalWaiver` and `autoRefundFailed` ' +
    'must be JSON booleans; `refundHoursBeforeDispatch` a whole number from 0 to 72. Any other key is `422` on that key ("This is not a storefront setting."); so is a value that does not fit. Every changed ' +
    'key writes an audit row. The answer holds the policies that have a value after the change (the same values `GET /admin/settings` shows). ' +
    '`require3ds` is also the risk rule of that name: one stored value, so a change here shows on `GET /admin/risk/rules`. ' +
    'Sending `require3ds` also needs `risk:*`, the permission of `PUT /admin/risk/rules` (`403 FORBIDDEN`, decision 046).',
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
