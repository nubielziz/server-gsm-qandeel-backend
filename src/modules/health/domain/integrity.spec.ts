// Unit tests of the integrity check's pure side: labels and references of the findings, the result shape and its reading back.
import { describe, expect, it } from 'bun:test';
import {
  CHECK_KEYS,
  accountLabel,
  accountRef,
  checkResult,
  checksFromResult,
  countsAsLastRun,
  entryLabel,
  integrityResult,
  isCleanRun,
  kindInWords,
  mismatchCountOf,
  overallResult,
  unknownChecks,
} from './integrity';

const finding = (id: number) => ({
  kind: 'account' as const,
  id,
  ref: `client_wallet:${id}`,
  label: 'Wallet · X',
  difference: '-37.5000',
  ageSeconds: null,
  lastEntryAt: null,
});

describe('finding labels and references (health-commissions-9)', () => {
  it('names accounts by their owner', () => {
    expect(accountRef('client_wallet', 4)).toBe('client_wallet:4');
    expect(accountRef('bank', null)).toBe('bank');
    expect(accountLabel('client_wallet', 4, 'Basra Unlock Center')).toBe('Wallet · Basra Unlock Center');
    expect(accountLabel('client_hold', 4, 'Basra Unlock Center')).toBe('Hold · Basra Unlock Center');
    expect(accountLabel('supplier_prepaid', 2, 'Gulf Server Hub')).toBe('Supplier prepaid · Gulf Server Hub');
    expect(accountLabel('client_wallet', 4, null)).toBe('Wallet · #4');
    expect(accountLabel('bank', null, null)).toBe('Bank');
    expect(accountLabel('gateway_clearing', null, null)).toBe('Gateway clearing');
    expect(kindInWords('owner_capital')).toBe('Owner capital');
  });

  it('names entries by kind and reference', () => {
    expect(entryLabel('order_hold', 'order', 48100)).toBe('order_hold · order #48100');
    expect(entryLabel('settlement', 'system', 0)).toBe('settlement · system');
  });
});

describe('checkResult', () => {
  it('passes with a zero difference when nothing was found, except stuck holds which carry no money', () => {
    expect(checkResult('entries_balanced', 0, [], null)).toMatchObject({
      status: 'pass',
      count: 0,
      difference: '0.0000',
    });
    expect(checkResult('stuck_holds', 0, [], null)).toMatchObject({ status: 'pass', difference: null });
  });

  it('fails with the full count and at most the first 20 findings', () => {
    const many = Array.from({ length: 25 }, (_, index) => finding(index + 1));
    const check = checkResult('accounts_match_lines', 25, many, '-937.5000');
    expect(check).toMatchObject({ status: 'fail', count: 25, difference: '-937.5000' });
    expect(check.findings).toHaveLength(20);
  });
});

describe('the run result (B99)', () => {
  const checks = [
    checkResult('entries_balanced', 0, [], null),
    checkResult('accounts_match_lines', 1, [finding(214)], '-37.5000'),
    checkResult('stuck_holds', 2, [], null),
    checkResult('payments_without_entry', 0, [], null),
  ];

  it('keeps counters at the top level and the checks under one key', () => {
    const result = integrityResult(checks, { accountsChecked: 48, entriesChecked: 3923, transactionsChecked: 1800 });
    expect(result).toMatchObject({
      failedChecks: 2,
      mismatchCount: 1,
      accountsChecked: 48,
      entriesChecked: 3923,
      transactionsChecked: 1800,
      unbalancedEntries: 0,
      accountDifferences: 1,
      stuckHolds: 2,
      paymentsWithoutEntry: 0,
    });
    expect(result.checks).toEqual(checks);
  });

  it('counts a mismatch as every finding of the three money checks, not the stuck holds', () => {
    expect(mismatchCountOf(checks)).toBe(1);
    expect(mismatchCountOf(unknownChecks())).toBe(0);
  });

  it('reads the checks back in the map order, and an absent check reads unknown, never pass', () => {
    expect(
      checksFromResult(integrityResult(checks, { accountsChecked: 1, entriesChecked: 1, transactionsChecked: 1 })).map(
        (c) => c.key,
      ),
    ).toEqual([...CHECK_KEYS]);
    expect(checksFromResult({}).every((check) => check.status === 'unknown')).toBe(true);
    expect(checksFromResult(null)).toEqual(unknownChecks());
    const partial = checksFromResult({ checks: [checks[1]] });
    expect(partial.map((check) => check.status)).toEqual(['unknown', 'fail', 'unknown', 'unknown']);
  });
});

describe('the verdicts', () => {
  it('a run is clean only when it succeeded with no failed check', () => {
    expect(isCleanRun('succeeded', { failedChecks: 0 })).toBe(true);
    expect(isCleanRun('succeeded', { failedChecks: 1 })).toBe(false);
    expect(isCleanRun('failed', { failedChecks: 0 })).toBe(false);
    expect(isCleanRun('succeeded', {})).toBe(false);
  });

  it('a skipped run is never the last run', () => {
    expect(countsAsLastRun('skipped')).toBe(false);
    expect(countsAsLastRun('failed')).toBe(true);
    expect(countsAsLastRun('succeeded')).toBe(true);
  });

  it('the overall result is the worst check: fail, then unknown, then pass', () => {
    expect(overallResult(unknownChecks())).toBe('unknown');
    expect(overallResult([checkResult('entries_balanced', 0, [], null)])).toBe('pass');
    expect(overallResult([checkResult('entries_balanced', 1, [], '1.0000'), ...unknownChecks()])).toBe('fail');
  });
});
