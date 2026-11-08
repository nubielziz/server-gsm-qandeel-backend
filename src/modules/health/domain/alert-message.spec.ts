// Unit tests of the words of an alert's messages (feature 12b): amounts with their unit, the window, the subject, the detail of each kind of message
// and the account of a ledger mismatch.
import { describe, expect, it } from 'bun:test';
import type { Finding } from './integrity';
import {
  type AlertMessageFacts,
  formatAmount,
  formatWindow,
  ledgerDetail,
  messageVariables,
  subjectText,
} from './alert-message';

const facts: AlertMessageFacts = {
  ruleName: 'Supplier timeouts',
  severity: 'critical',
  metric: 'supplier.timeout_rate',
  unit: 'percent',
  value: 25,
  threshold: 20,
  comparator: 'gt',
  windowSeconds: 180,
  startedAt: new Date('2026-11-07T10:00:00.000Z'),
  subjectType: 'supplier',
  subjectLabel: 'Bosphorus Unlock',
  detail: null,
};

describe('formatAmount', () => {
  it('writes the number with the unit the way a person reads it', () => {
    expect(formatAmount(25, 'percent')).toBe('25%');
    expect(formatAmount(1200, 'ms')).toBe('1200 ms');
    expect(formatAmount(90, 's')).toBe('90 s');
    expect(formatAmount(12, 'per_min')).toBe('12/min');
    expect(formatAmount(3, 'bytes')).toBe('3 bytes');
    expect(formatAmount(7, 'count')).toBe('7');
    expect(formatAmount(150, null)).toBe('150');
  });

  it('keeps at most two decimals and drops trailing zeros', () => {
    expect(formatAmount(42.857142, 'percent')).toBe('42.86%');
    expect(formatAmount(20.5, 'percent')).toBe('20.5%');
    expect(formatAmount(20.0, 'percent')).toBe('20%');
  });
});

describe('formatWindow', () => {
  it('uses whole hours, then whole minutes, else seconds', () => {
    expect(formatWindow(7200)).toBe('2 h');
    expect(formatWindow(180)).toBe('3 min');
    expect(formatWindow(90)).toBe('90 s');
    expect(formatWindow(45)).toBe('45 s');
  });
});

describe('subjectText', () => {
  it('names a supplier or a queue and says Platform for the whole system', () => {
    expect(subjectText('supplier', 'Bosphorus Unlock')).toBe('Supplier Bosphorus Unlock');
    expect(subjectText('queue', 'orders')).toBe('Queue orders');
    expect(subjectText('system', null)).toBe('Platform');
    expect(subjectText('supplier', null)).toBe('Platform');
    expect(subjectText('system', 'Everything')).toBe('Everything');
  });
});

describe('messageVariables', () => {
  it('words a fired alert: the rule, the value against the limit with the unit, the subject and the limit with its window', () => {
    expect(messageVariables('fired', facts)).toEqual({
      ruleName: 'Supplier timeouts',
      severity: 'critical',
      metric: 'supplier.timeout_rate',
      value: '25%',
      threshold: '20%',
      subject: 'Supplier Bosphorus Unlock',
      detail: 'The limit is above 20% over 3 min.',
    });
  });

  it('words a reminder with the round and the time since the alert fired', () => {
    expect(messageVariables('reminder', facts, 2).detail).toBe(
      'Reminder 2: still firing since 2026-11-07 10:00 UTC and not acknowledged.',
    );
  });

  it('words a recovery as back in range, or with the reason the evaluator or the rule service gives', () => {
    expect(messageVariables('resolved', { ...facts, value: 0 }).detail).toBe('The value is back in range.');
    expect(messageVariables('resolved', { ...facts, detail: 'The rule was switched off.' }).detail).toBe(
      'The rule was switched off.',
    );
  });

  it('does not name a window for the mismatch count, which is the outcome of a run, and adds the evaluator sentence', () => {
    const variables = messageVariables('fired', {
      ...facts,
      metric: 'ledger.mismatch_count',
      unit: 'count',
      value: 1,
      threshold: 0,
      windowSeconds: 60,
      subjectType: 'system',
      subjectLabel: null,
      detail: 'Wallet · Cairo GSM Lab differs by 37.5000.',
    });
    expect(variables).toMatchObject({ value: '1', threshold: '0', subject: 'Platform' });
    expect(variables.detail).toBe('The limit is above 0. Wallet · Cairo GSM Lab differs by 37.5000.');
  });

  it('words every comparator', () => {
    const word = (comparator: AlertMessageFacts['comparator']) =>
      messageVariables('fired', { ...facts, comparator, threshold: 150, unit: null }).detail;
    expect(word('gt')).toContain('above 150');
    expect(word('gte')).toContain('at or above 150');
    expect(word('lt')).toContain('below 150');
    expect(word('lte')).toContain('at or below 150');
  });
});

describe('ledgerDetail', () => {
  const finding = (label: string, difference: string): Finding => ({
    kind: 'account',
    id: 1,
    ref: 'client_wallet:1',
    label,
    difference,
    ageSeconds: null,
    lastEntryAt: null,
  });

  it('names the first account and its difference, and how many more differ', () => {
    expect(ledgerDetail([finding('Wallet · Cairo GSM Lab', '37.5000')], 1)).toBe(
      'Wallet · Cairo GSM Lab differs by 37.5000.',
    );
    expect(ledgerDetail([finding('Wallet · Cairo GSM Lab', '37.5000'), finding('Wallet · B', '1.0000')], 3)).toBe(
      'Wallet · Cairo GSM Lab differs by 37.5000 (and 2 more).',
    );
  });

  it('is empty when no account is named', () => {
    expect(ledgerDetail([], 0)).toBe('');
  });
});
