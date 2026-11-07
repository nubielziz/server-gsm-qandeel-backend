// The timeline lines of an order (RESOLUTIONS orders-suppliers-15): which `order_events` rows each transition writes and the words
// of their `data.message`, in the console's style ("$3.31 held from Phone Doctor FZE wallet"). Pure; the use case stores them.
import type { OrderEventActorType, OrderEventType, OrderStatus } from '../db/schema';
import type { OrderMoneyMove } from './order-machine';

/** The reason a manual order opens the manual queue with (the console's `REVIEW_REASONS.manual`). */
export const MANUAL_REASON = 'Manual service: operator dispatch required';

/** The reason a verification request opens the verification queue with. */
export const VERIFICATION_REASON = 'The merchant asked for the result to be checked';

/** What the merchant sees as the reason of its own cancellation. */
export const MERCHANT_CANCEL_REASON = 'Cancelled by the merchant';

/** The default result text of a verification refund when staff write no note. */
export const VERIFICATION_REFUND_REASON = 'Verification refund';

/** Who caused an event. */
export interface TimelineActor {
  readonly type: OrderEventActorType;
  readonly id: number | null;
}

/** One line to append to the timeline. */
export interface TimelineLine {
  readonly type: OrderEventType;
  readonly actor: TimelineActor;
  readonly fromStatus: OrderStatus | null;
  readonly toStatus: OrderStatus | null;
  readonly data: Record<string, string | number | boolean | null>;
}

/** The system actor: placement bookkeeping, settlements and releases. */
export const SYSTEM_ACTOR: TimelineActor = { type: 'system', id: null };

/**
 * Writes an amount the way the demo's timeline does: `$3.31`, `$0.0900`, `$73.80`.
 *
 * @param wire a 4-decimal money text such as `3.3100`
 * @returns dollars with two decimals, or four when the last two are not zero
 */
export function dollars(wire: string): string {
  const [whole = '0', fraction = '0000'] = wire.split('.');
  return `$${whole}.${fraction.slice(2) === '00' ? fraction.slice(0, 2) : fraction.padEnd(4, '0')}`;
}

/** The label of a placement source in the first timeline line (the demo's "Order received via Dhru API"). */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  dhru: 'Dhru API',
  v1: 'REST API',
  portal: 'Portal',
  store: 'Storefront',
  admin: 'the admin console',
};

/**
 * The first line of a new order.
 *
 * @param source the placement source (`portal`, `dhru`, `v1`, `store`, `admin`)
 * @param actor who placed it
 * @returns the `created` line
 */
export function createdLine(source: string, actor: TimelineActor): TimelineLine {
  return {
    type: 'created',
    actor,
    fromStatus: null,
    toStatus: null,
    data: { message: `Order received via ${SOURCE_LABELS[source] ?? source}`, source },
  };
}

/**
 * The line that says the price is held.
 *
 * @param amountWire the held price
 * @param merchantName the merchant's name
 * @returns the `hold` line
 */
export function holdLine(amountWire: string, merchantName: string): TimelineLine {
  return {
    type: 'hold',
    actor: SYSTEM_ACTOR,
    fromStatus: null,
    toStatus: null,
    data: { message: `${dollars(amountWire)} held from ${merchantName} wallet`, amount: amountWire },
  };
}

/**
 * The line that puts a new order in the manual queue.
 *
 * @returns the `review` line carrying the reason the queue shows
 */
export function manualReviewLine(): TimelineLine {
  return {
    type: 'review',
    actor: SYSTEM_ACTOR,
    fromStatus: null,
    toStatus: null,
    data: { message: MANUAL_REASON, reason: MANUAL_REASON },
  };
}

/** What the lines of a transition need to know beyond the machine's answer. */
export interface TransitionContext {
  readonly actor: TimelineActor;
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  /** The buyer-visible reason of a reject, refund or reopen. */
  readonly reason?: string | undefined;
  /** The decision of a verification: `accept` or `refund`. */
  readonly decision?: 'accept' | 'refund' | undefined;
  /** The staff note that came with a verification decision. */
  readonly note?: string | undefined;
  /** The money that moved (4-decimal texts); `posted` is false for a free order. */
  readonly money: { readonly posted: boolean; readonly amount: string; readonly cost: string };
}

function line(
  type: OrderEventType,
  actor: TimelineActor,
  data: TimelineLine['data'],
  status?: { from: OrderStatus; to: OrderStatus },
): TimelineLine {
  return { type, actor, fromStatus: status?.from ?? null, toStatus: status?.to ?? null, data };
}

/**
 * The lines one transition writes.
 *
 * Why: orders-suppliers-15 and the endpoint docs: `accept` writes `accepted`; `reply` writes `completed` then `settle` (system);
 * `reject` and a cancel write `rejected` then `release` (B2B) or `refund` (B2C); a B2B `refund` writes `rejected` then `refund`;
 * `reopen` writes `reopened`; a verification request and each decision write `verification` (a refund decision adds the refund's
 * `rejected` and `refund`). The buyer-visible reason goes in `data.reason`, the console's wording in `data.message`.
 *
 * @param event the event type the machine named for the transition
 * @param money the money move the machine named, or `null`
 * @param context the actor, the statuses, the reason and the money that moved
 * @returns the lines, in the order they happened
 */
export function transitionLines(
  event: OrderEventType,
  money: OrderMoneyMove | null,
  context: TransitionContext,
): TimelineLine[] {
  const status = { from: context.from, to: context.to };
  const amount = dollars(context.money.amount);
  const reason = context.reason?.trim() ? context.reason.trim() : undefined;
  switch (event) {
    case 'accepted':
      return [line('accepted', context.actor, { message: 'Accepted for manual fulfilment' }, status)];
    case 'completed': {
      const cost = dollars(context.money.cost);
      return [
        line('completed', context.actor, { message: 'Completed by staff reply' }, status),
        line('settle', SYSTEM_ACTOR, {
          message: `Settled: revenue ${amount}, cost ${cost}`,
          revenue: context.money.amount,
          cost: context.money.cost,
        }),
      ];
    }
    case 'rejected':
      return [
        line('rejected', context.actor, { message: reason ?? 'Rejected', reason: reason ?? null }, status),
        money === 'b2c_refund'
          ? line('refund', SYSTEM_ACTOR, {
              message: `Refund of ${amount} sent to the original payment method`,
              amount: context.money.amount,
            })
          : line('release', SYSTEM_ACTOR, {
              message: `${amount} released back to wallet`,
              amount: context.money.amount,
            }),
      ];
    case 'refund':
      return refundLines(context, status, reason, amount);
    case 'reopened':
      return [
        line(
          'reopened',
          context.actor,
          {
            message: reason ? `Reopened: ${reason}` : 'Reopened, back to Processing',
            reason: reason ?? null,
          },
          status,
        ),
      ];
    case 'verification': {
      if (context.decision === undefined) {
        return [
          line('verification', context.actor, {
            message: 'Verification requested by the merchant',
            reason: VERIFICATION_REASON,
          }),
        ];
      }
      const note = context.note?.trim();
      const decision = line('verification', context.actor, {
        message: `Verification: result ${context.decision === 'accept' ? 'accepted' : 'refunded'}${note ? `. ${note}` : ''}`,
        decision: context.decision,
        ...(note ? { note } : {}),
      });
      return context.decision === 'accept'
        ? [decision]
        : [decision, ...refundLines(context, status, note ?? VERIFICATION_REFUND_REASON, amount)];
    }
    // The lines of the other events belong to the features that write them (suppliers, risk, notifications, disputes): a plain line.
    case 'created':
    case 'hold':
    case 'dispatch':
    case 'ack':
    case 'settle':
    case 'release':
    case 'retry':
    case 'review':
    case 'supplier_changed':
    case 'note':
    case 'paid':
    case 'risk':
    case 'notify':
    case 'dispute':
    case 'fetch':
      return [line(event, context.actor, {}, context.from === context.to ? undefined : status)];
  }
}

function refundLines(
  context: TransitionContext,
  status: { from: OrderStatus; to: OrderStatus },
  reason: string | undefined,
  amount: string,
): TimelineLine[] {
  return [
    line('rejected', context.actor, { message: reason ?? 'Refunded', reason: reason ?? null }, status),
    line('refund', SYSTEM_ACTOR, {
      message: `${amount} refunded to the wallet`,
      amount: context.money.amount,
      ...(reason ? { reason } : {}),
    }),
  ];
}
