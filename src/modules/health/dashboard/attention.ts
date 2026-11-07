// Pure rules of the dashboard's attention list: which supplier checks raise an item, how severe each kind is (RULES dashboard 3), and
// the ranking (resolutions identity-platform-9, -10; docs/contract/endpoints/platform.md `GET /admin/dashboard`).
import type { CheckStatus } from '../db/schema';

/** The words of an attention item's severity, most urgent first. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
/** One severity word. */
export type Severity = (typeof SEVERITIES)[number];

/**
 * The supplier health word of the dashboard row.
 *
 * Why: identity-platform-8: `ok` is `up`, `degraded` is `degraded`, `down` is `down`, and `unknown` or no check yet is `degraded`:
 * a supplier nobody has checked is never shown as healthy, and the console has no `unknown` word.
 *
 * @param status the supplier's latest check status, or `null` when it has no check
 * @returns `up`, `degraded` or `down`
 */
export function dashboardHealth(status: CheckStatus | null): 'up' | 'degraded' | 'down' {
  return status === 'ok' ? 'up' : status === 'down' ? 'down' : 'degraded';
}

/**
 * The attention kind a supplier's latest check raises.
 *
 * Why: identity-platform-9: `supplier_down` and `supplier_degraded` fire only from a real `down` or `degraded` result, never from
 * `unknown` or no check, so a new supplier does not raise a false alert.
 *
 * @param status the latest check status, or `null` when there is none
 * @returns the item kind, or `null` when the check raises nothing
 */
export function supplierAttentionKind(status: CheckStatus | null): 'supplier_down' | 'supplier_degraded' | null {
  return status === 'down' ? 'supplier_down' : status === 'degraded' ? 'supplier_degraded' : null;
}

/**
 * The severity of each attention kind that has one fixed word.
 *
 * Why: RULES dashboard 3 gives every kind its severity, and the console ranks and colours by it, so the words live in one table that a
 * unit test compares with the rule (a count or an age never moves a kind up or down). `disputes_due` is the one kind that depends on
 * something else: see {@link disputesDueSeverity}.
 */
export const ATTENTION_SEVERITY = {
  orders_past_sla: 'critical',
  orders_review: 'high',
  supplier_down: 'critical',
  supplier_degraded: 'high',
  supplier_balance_low: 'medium',
  services_below_floor: 'high',
  deposits_pending: 'medium',
  wallets_negative: 'medium',
  merchants_pending: 'low',
  commissions_accrued: 'low',
  orders_held: 'high',
  tickets_late: 'medium',
  refunds_requested: 'medium',
  refunds_failed: 'high',
  fx_stale: 'medium',
} as const satisfies Record<string, Severity>;

/** How close the first dispute's evidence deadline must be for the item to be critical (and for `navCounts.refunds.disputesDueSoon`). */
export const DISPUTE_DUE_SOON_MS = 3 * 86_400_000;

/**
 * Severity of the disputes item.
 *
 * Why: RULES dashboard 3: `disputes_due` is critical when the first dispute (the earliest evidence deadline) is due within 3 days,
 * else high. A deadline that has passed is within 3 days. The same window counts `disputesDueSoon` in the sidebar.
 *
 * @param dueAt the earliest evidence deadline among the disputes that need a response
 * @param now the clock's time
 * @returns `critical` or `high`
 */
export function disputesDueSeverity(dueAt: Date, now: Date): Severity {
  return dueAt.getTime() - now.getTime() <= DISPUTE_DUE_SOON_MS ? 'critical' : 'high';
}

/**
 * Orders the items critical, then high, medium, low; items of one severity keep the order they were added in (a stable sort).
 *
 * @param items the items with their severity
 * @returns a new list, most urgent first
 */
export function rankAttention<T extends { readonly severity: Severity }>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => SEVERITIES.indexOf(a.item.severity) - SEVERITIES.indexOf(b.item.severity) || a.index - b.index)
    .map(({ item }) => item);
}
