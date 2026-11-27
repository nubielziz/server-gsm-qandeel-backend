// When the merchant's two actions on an order are open, until when, and why not (decision 075): the cancel window of a website order,
// and the reasons the portal shows beside a Cancel or Verify button that is not available.
import type { Order } from '../db/schema';
import { isOpen } from './order-machine';

/**
 * How long a website order of a service that allows cancellation waits before it is sent to its supplier: two minutes.
 *
 * Why: decision 075 (the owner's order of 2026-11-27): an automatic order is sent in the same second it is placed, and a merchant may cancel
 * only an order that was never sent (decisions 025 and 044), so the Cancel button of such a service could never be used. The dispatch job
 * waits this long, and the portal shows the end of the wait as `cancelUntil`.
 */
export const CANCEL_WINDOW_MS = 120_000;

/** What the cancel window of an order is decided on; an `OrderRow` of the read model has this shape. */
export interface CancelWindowFacts {
  readonly order: Pick<Order, 'source' | 'status' | 'dispatchState' | 'sentAt' | 'placedAt'>;
  /** The service's `allow_cancel` as it is now (read when the decision is made, never the value at placement). */
  readonly allowCancel: boolean;
  /** True once the order has a `dispatch` event: it was claimed for a supplier call at least once (decision 044). */
  readonly everDispatched: boolean;
}

/**
 * The end of the cancel window of an order, while the order is inside it.
 *
 * Why: decision 075: an order placed on the website (`source = 'portal'`) for a service that allows cancellation (now) waits
 * {@link CANCEL_WINDOW_MS} after it was placed before the dispatch job may claim it, so the merchant can cancel it. Only an order that
 * still waits for its first send counts: open, `dispatch_state = 'pending'`, `sent_at` empty and never claimed. Dhru and shop orders,
 * manual and held orders and a service without `allow_cancel` never wait. The one rule of the dispatch job (it defers the claim) and of
 * the portal's `cancelUntil`, so the two never disagree.
 *
 * @param facts the order, its service's `allow_cancel` now and whether it was ever claimed
 * @param now the injected clock's time
 * @returns `placed_at + CANCEL_WINDOW_MS` while `now` is before it and the order is inside its window, else `null`
 */
export function cancelWindowEnd(facts: CancelWindowFacts, now: Date): Date | null {
  const { order } = facts;
  if (order.source !== 'portal' || !facts.allowCancel || facts.everDispatched) return null;
  if (!isOpen(order.status) || order.dispatchState !== 'pending' || order.sentAt !== null) return null;
  const end = new Date(order.placedAt.getTime() + CANCEL_WINDOW_MS);
  return now.getTime() < end.getTime() ? end : null;
}

/**
 * Why the merchant's Cancel is not available, in the order the portal reads them (decision 075).
 *
 * - `closed`: the order is completed or rejected;
 * - `not_allowed`: the service does not allow cancellation;
 * - `already_sent`: the order was sent to a supplier or claimed for a send at least once (the machine's `ALREADY_SENT`);
 * - `in_progress`: anything else (staff are working on it, or it waits for a person).
 */
export const CANCEL_BLOCKED_REASONS = ['closed', 'not_allowed', 'already_sent', 'in_progress'] as const;

/** One value of {@link CANCEL_BLOCKED_REASONS}. */
export type CancelBlocked = (typeof CANCEL_BLOCKED_REASONS)[number];

/**
 * Why the merchant's Verify is not available, in the order the portal reads them (decision 075).
 *
 * - `already_requested`: a verification was asked for already (one per order);
 * - `not_allowed`: the service does not allow verification;
 * - `not_completed`: the order is not completed;
 * - `window_passed`: the service's `verify_window_h` hours since completion have passed (a window of 0 hours included).
 */
export const VERIFY_BLOCKED_REASONS = ['already_requested', 'not_allowed', 'not_completed', 'window_passed'] as const;

/** One value of {@link VERIFY_BLOCKED_REASONS}. */
export type VerifyBlocked = (typeof VERIFY_BLOCKED_REASONS)[number];
