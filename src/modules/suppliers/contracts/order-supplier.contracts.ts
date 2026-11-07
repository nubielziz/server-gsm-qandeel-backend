// Route contracts of the three order moves that involve a supplier (map domain D routes, built with stage 6): force a send, fetch the
// result now, change the supplier of an order. Bodies match the console (`src/features/orders/api/actions.ts`), resolutions
// orders-suppliers-11, -12, -17 and -19.
import { z } from 'zod';
import { defineRoute, zId, zIdParam } from '../../../common/contract';

const id = z.object({ id: zIdParam });

/** `POST /admin/orders/:id/dispatch`. */
export const dispatchOrder = defineRoute({
  key: 'POST /admin/orders/:id/dispatch',
  summary: 'Send an order to its supplier now',
  description:
    'Staff retry: an order in `needs_attention`, `manual` or `operator` goes to `pending` and the dispatch job is queued (an `order.' +
    'dispatch_requested` outbox row; the answer does not wait for the supplier). The order goes to the supplier service it already ' +
    'has, else the first active link whose supplier is active; the price-protection limit of the automatic dispatch does not apply. ' +
    'No money moves: the hold stays. An order already `pending` is a `204` that changes nothing. Writes a `retry` event and an audit row.',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:update',
  params: id,
  body: z.object({}),
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'ORDER_NOT_OPEN',
    'ORDER_HELD',
    'ALREADY_SENT',
    'NO_SUPPLIER',
    'SUPPLIER_DISABLED',
    'INVALID_TRANSITION',
    'VALIDATION_FAILED',
  ],
  examples: { request: {} },
});

/** `POST /admin/orders/:id/fetch`. */
export const fetchOrder = defineRoute({
  key: 'POST /admin/orders/:id/fetch',
  summary: "Fetch the supplier's result now",
  description:
    "Calls `getimeiorder` for the order's supplier reference (logged). STATUS 4 completes the order (result code, settlement, the " +
    'supplier cost booked), STATUS 3 rejects it (the hold goes back); still running writes a `fetch` event ("Supplier has not finished ' +
    'yet") and an order in `needs_attention` goes back to `sent` (polling resumes). First action after a timeout when a reference ' +
    'exists. An unreachable supplier is `409 SUPPLIER_UNAVAILABLE`.',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:update',
  params: id,
  body: z.object({}),
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'ORDER_NOT_OPEN',
    'NO_REFERENCE',
    'SUPPLIER_UNAVAILABLE',
    'INVALID_TRANSITION',
    'VALIDATION_FAILED',
  ],
  examples: { request: {} },
});

/** `POST /admin/orders/:id/change-supplier`. */
export const changeOrderSupplier = defineRoute({
  key: 'POST /admin/orders/:id/change-supplier',
  summary: 'Change the supplier of an order',
  description:
    "Points the order at another supplier (`supplierId`: the supplier's id; its active link of the order's service with the lowest " +
    'priority gives the supplier service) and/or forgets the old reference (`resetReference`). Nothing is sent to the supplier. ' +
    '`unit_cost` and `total_cost` are refreshed from the chosen link (`credit x credit_rate`; the price stays); a costlier link is ' +
    'allowed for staff and the `supplier_changed` event records `costAbovePrice`. The dispatch state stays, except `sent` with ' +
    '`resetReference`, which becomes `needs_attention`; with `dispatch: true` it becomes `pending` and the job is queued in the same ' +
    'transaction. Neither `supplierId` nor `resetReference: true` is `422` on `supplierId`; the same supplier without a reset is a ' +
    '`204` with no event.',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:update',
  params: id,
  body: z.object({
    supplierId: zId.optional(),
    resetReference: z.boolean().optional(),
    dispatch: z.boolean().optional(),
  }),
  success: { status: 204 },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'ORDER_NOT_OPEN',
    'ORDER_HELD',
    'SUPPLIER_DISABLED',
    'VALIDATION_FAILED',
  ],
  examples: { request: { supplierId: 3, resetReference: true, dispatch: true } },
});
