// Unit tests of the integrity check's pure side: labels and references of the findings, the result shape and its reading back. The check
// has five parts: the map's four and `wallets_follow_rank` (decision 064).
import { describe, expect, it } from 'bun:test';
import {
  CHECKS,
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
  rankFindingLabel,
  unknownChecks,
} from '@src/modules/health/domain/integrity';

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
    expect(accountLabel('customer_wallet', 7, 'Daniel Rivera')).toBe('Customer wallet · Daniel Rivera');
    expect(accountLabel('customer_wallet', 7, null)).toBe('Customer wallet · #7');
    expect(accountLabel('client_wallet', 4, null)).toBe('Wallet · #4');
    expect(accountLabel('bank', null, null)).toBe('Bank');
    expect(accountLabel('gateway_clearing', null, null)).toBe('Gateway clearing');
    expect(kindInWords('owner_capital')).toBe('Owner capital');
  });

  it('says what is wrong with a wallet that does not follow its rank, with the name of its account', () => {
    expect(rankFindingLabel('inactive_wallet', 'client_wallet', 4, 'Basra Unlock Center')).toBe(
      'Wallet · Basra Unlock Center · not the wallet of its rank',
    );
    expect(rankFindingLabel('inactive_wallet', 'customer_wallet', 7, 'Daniel Rivera')).toBe(
      'Customer wallet · Daniel Rivera · not the wallet of its rank',
    );
    expect(rankFindingLabel('credit_without_rank', 'client_wallet', 4, 'Basra Unlock Center')).toBe(
      'Wallet · Basra Unlock Center · credit on a rank without credit',
    );
    // No account row: the id stands in for the name.
    expect(rankFindingLabel('no_account', 'client_wallet', 424242, null)).toBe(
      'Wallet · #424242 · no account behind it',
    );
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
    checkResult('wallets_follow_rank', 0, [], null),
  ];

  it('has the five checks in order, the fifth about accounts and counted in money', () => {
    expect([...CHECK_KEYS]).toEqual([
      'entries_balanced',
      'accounts_match_lines',
      'stuck_holds',
      'payments_without_entry',
      'wallets_follow_rank',
    ]);
    expect(CHECKS.wallets_follow_rank).toEqual({
      label: 'Every wallet follows the rank of its account',
      kind: 'account',
      money: true,
    });
    expect(unknownChecks()).toHaveLength(5);
  });

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
      walletsOffRank: 0,
    });
    expect(result.checks).toEqual(checks);
  });

  it('counts a mismatch as every finding of the money checks, not the stuck holds', () => {
    expect(mismatchCountOf(checks)).toBe(1);
    expect(mismatchCountOf(unknownChecks())).toBe(0);
  });

  it('counts a wallet that does not follow its rank as a mismatch (money sits where it should not) and stores its count', () => {
    const off = [...checks.slice(0, 4), checkResult('wallets_follow_rank', 3, [finding(9)], '112.5000')];
    expect(mismatchCountOf(off)).toBe(4);
    expect(integrityResult(off, { accountsChecked: 1, entriesChecked: 1, transactionsChecked: 1 })).toMatchObject({
      walletsOffRank: 3,
      mismatchCount: 4,
      failedChecks: 3,
    });
    expect(off[4]).toMatchObject({ key: 'wallets_follow_rank', status: 'fail', count: 3, difference: '112.5000' });
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
    expect(partial.map((check) => check.status)).toEqual(['unknown', 'fail', 'unknown', 'unknown', 'unknown']);
    // A run stored before the fifth check existed shows it unknown until the next run, never pass.
    const old = checksFromResult({ checks: checks.slice(0, 4) });
    expect(old.map((check) => check.status)).toEqual(['pass', 'fail', 'fail', 'pass', 'unknown']);
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
