// Unit tests of the dashboard attention rules: the four supplier health mappings, which checks raise an item, the fixed severity of
// each kind (RULES dashboard 3) and the ranking.
import { describe, expect, it } from 'bun:test';
import {
  ATTENTION_SEVERITY,
  DISPUTE_DUE_SOON_MS,
  dashboardHealth,
  disputesDueSeverity,
  rankAttention,
  supplierAttentionKind,
} from './attention';

describe('dashboardHealth (identity-platform-8)', () => {
  it('maps ok to up, degraded to degraded, down to down, and unknown or no check to degraded', () => {
    expect(dashboardHealth('ok')).toBe('up');
    expect(dashboardHealth('degraded')).toBe('degraded');
    expect(dashboardHealth('down')).toBe('down');
    expect(dashboardHealth('unknown')).toBe('degraded');
    expect(dashboardHealth(null)).toBe('degraded');
  });
});

describe('supplierAttentionKind (identity-platform-9)', () => {
  it('fires only from a real down or degraded result', () => {
    expect(supplierAttentionKind('down')).toBe('supplier_down');
    expect(supplierAttentionKind('degraded')).toBe('supplier_degraded');
    expect(supplierAttentionKind('ok')).toBeNull();
    expect(supplierAttentionKind('unknown')).toBeNull();
    expect(supplierAttentionKind(null)).toBeNull();
  });
});

describe('the severity of each kind (RULES dashboard 3)', () => {
  it('is the rule, word for word, and never depends on a count', () => {
    expect(ATTENTION_SEVERITY).toEqual({
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
    });
  });

  it('makes the disputes item critical when the first deadline is within 3 days (a passed one included), else high', () => {
    const now = new Date('2026-05-01T12:00:00.000Z');
    const due = (ms: number) => new Date(now.getTime() + ms);
    expect(disputesDueSeverity(due(-60_000), now)).toBe('critical');
    expect(disputesDueSeverity(due(60_000), now)).toBe('critical');
    expect(disputesDueSeverity(due(DISPUTE_DUE_SOON_MS), now)).toBe('critical');
    expect(disputesDueSeverity(due(DISPUTE_DUE_SOON_MS + 1), now)).toBe('high');
  });
});

describe('rankAttention', () => {
  it('ranks critical, high, medium, low and keeps the order inside a severity', () => {
    const items = [
      { id: 'a', severity: 'low' as const },
      { id: 'b', severity: 'high' as const },
      { id: 'c', severity: 'critical' as const },
      { id: 'd', severity: 'high' as const },
      { id: 'e', severity: 'medium' as const },
    ];
    expect(rankAttention(items).map((item) => item.id)).toEqual(['c', 'b', 'd', 'e', 'a']);
    expect(items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
