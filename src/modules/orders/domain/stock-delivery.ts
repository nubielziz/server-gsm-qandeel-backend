// The timeline lines of an order delivered from the code inventory at placement (RULES orders 10): it completes at once and
// settles. Kept apart from order-timeline.ts, whose lines follow a transition of the state machine.
import type { OrderStatus } from '../db/schema';
import { SYSTEM_ACTOR, type TimelineLine, dollars } from './order-timeline';

/** The status a stocked order passes through on its way to completed: the merchant's event says `pending → completed`. */
export const STOCK_DELIVERY_FROM: OrderStatus = 'pending';

/**
 * The lines an order delivered from stock adds after its `created` and `hold` lines.
 *
 * Why: the console's timeline shows every step (orders-suppliers-15): the order completes at once (`completed`, by the system,
 * pending → completed) and settles (`settle`: revenue only, because no supplier executed it, B17).
 *
 * @param count how many codes were delivered
 * @param money the money the settlement moved (4-decimal texts)
 * @returns the `completed` and `settle` lines, in that order
 */
export function stockDeliveryLines(
  count: number,
  money: { readonly amount: string; readonly cost: string },
): TimelineLine[] {
  return [
    {
      type: 'completed',
      actor: SYSTEM_ACTOR,
      fromStatus: STOCK_DELIVERY_FROM,
      toStatus: 'completed',
      data: { message: count === 1 ? 'Delivered from stock: 1 code' : `Delivered from stock: ${String(count)} codes` },
    },
    {
      type: 'settle',
      actor: SYSTEM_ACTOR,
      fromStatus: null,
      toStatus: null,
      data: {
        message: `Settled: revenue ${dollars(money.amount)}, cost ${dollars(money.cost)}`,
        revenue: money.amount,
        cost: money.cost,
      },
    },
  ];
}
