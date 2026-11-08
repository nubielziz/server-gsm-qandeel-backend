// Unit tests of the alert metric registry: eleven keys, their wire units and the subject each one raises.
import { describe, expect, it } from 'bun:test';
import { METRICS, METRIC_KEYS, isMetricKey, unitOf } from './metric-registry';

describe('the metric registry', () => {
  it('has the eleven keys of the console with the units of health-commissions-13', () => {
    expect(METRIC_KEYS).toHaveLength(11);
    const units = Object.fromEntries(METRIC_KEYS.map((key) => [key, METRICS[key].unit]));
    expect(units).toEqual({
      'supplier.timeout_rate': 'percent',
      'supplier.error_rate': 'percent',
      'supplier.balance': null,
      'api.p95': 'ms',
      'api.rate5xx': 'percent',
      'queue.oldest_age': 's',
      'orders.past_sla': 'count',
      'ledger.mismatch_count': 'count',
      'db.connection_usage': 'percent',
      'redis.memory_usage': 'percent',
      'webhooks.success_rate': 'percent',
    });
  });

  it('fixes the subject: supplier.* raise supplier alerts, queue.oldest_age a queue alert, the rest the system (health-commissions-14)', () => {
    const subjects = Object.fromEntries(METRIC_KEYS.map((key) => [key, METRICS[key].subject]));
    expect(subjects).toMatchObject({
      'supplier.timeout_rate': 'supplier',
      'supplier.error_rate': 'supplier',
      'supplier.balance': 'supplier',
      'queue.oldest_age': 'queue',
      'api.p95': 'system',
      'ledger.mismatch_count': 'system',
      'webhooks.success_rate': 'system',
    });
  });

  it('says what the rule window means: measured for rates and percentiles, held for readings of the moment, none for the integrity result', () => {
    const modes = Object.fromEntries(METRIC_KEYS.map((key) => [key, METRICS[key].window]));
    expect(modes).toEqual({
      'supplier.timeout_rate': 'measured',
      'supplier.error_rate': 'measured',
      'supplier.balance': 'held',
      'api.p95': 'measured',
      'api.rate5xx': 'measured',
      'queue.oldest_age': 'held',
      'orders.past_sla': 'held',
      'ledger.mismatch_count': 'run',
      'db.connection_usage': 'held',
      'redis.memory_usage': 'held',
      'webhooks.success_rate': 'measured',
    });
  });

  it('knows which metrics need Prometheus (the two api metrics only, ANSWERS Q15)', () => {
    expect(METRIC_KEYS.filter((key) => METRICS[key].source === 'prometheus')).toEqual(['api.p95', 'api.rate5xx']);
  });

  it('tells a metric from any other text and gives an unknown one no unit', () => {
    expect(isMetricKey('api.p95')).toBe(true);
    expect(isMetricKey('api.p99')).toBe(false);
    expect(unitOf('api.p95')).toBe('ms');
    expect(unitOf('supplier.balance')).toBeNull();
    expect(unitOf('made.up')).toBeNull();
  });
});
