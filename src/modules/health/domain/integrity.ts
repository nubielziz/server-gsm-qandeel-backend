// The pure side of the money integrity check (job `ledger_integrity`, feature 12b): the four checks in the map's order, how a finding is
// labelled, and what the job stores in `job_runs.result`. RESOLUTIONS health-commissions-9, ANSWERS system-health Q35 and Q36, B99.

/** The `job_runs.job` of the nightly and the manual integrity run. */
export const INTEGRITY_JOB = 'ledger_integrity';

/** How many findings of one check are kept in the result and sent: the first 20 (ANSWERS Q36); `count` is the full number. */
export const MAX_FINDINGS = 20;

/** A hold older than this with no release or settlement is stuck (map: "holds stuck over 24 hours"). */
export const STUCK_HOLD_HOURS = 24;

/** The four checks of the map, in its order. */
export const CHECK_KEYS = [
  'entries_balanced',
  'accounts_match_lines',
  'stuck_holds',
  'payments_without_entry',
] as const;
/** One check key. */
export type CheckKey = (typeof CHECK_KEYS)[number];

/** The kind of record a finding points at (the console's `IntegrityFinding.kind`). */
export type FindingKind = 'entry' | 'account' | 'hold' | 'payment';

/** The result of one check in a run. `unknown` when it never ran or the run did not finish. */
export type CheckStatus = 'pass' | 'fail' | 'unknown';

/** What each check is called, which findings it lists and whether it measures money. */
export const CHECKS: Readonly<Record<CheckKey, { label: string; kind: FindingKind; money: boolean }>> = {
  entries_balanced: { label: 'Every entry sums to zero', kind: 'entry', money: true },
  accounts_match_lines: { label: 'Every account balance equals the sum of its lines', kind: 'account', money: true },
  stuck_holds: { label: 'No hold is stuck for more than 24 hours', kind: 'hold', money: false },
  payments_without_entry: { label: 'Every confirmed payment has an entry', kind: 'payment', money: true },
};

/** One problem a check found (the console's `IntegrityFinding`); fields a kind does not use are `null`. */
export interface Finding {
  readonly kind: FindingKind;
  readonly id: number;
  readonly ref: string;
  readonly label: string;
  readonly difference: string | null;
  readonly ageSeconds: number | null;
  readonly lastEntryAt: string | null;
}

/** One check of a run, as stored in the result and sent by `GET /admin/system/integrity`. */
export interface CheckResult {
  readonly key: CheckKey;
  readonly label: string;
  readonly status: CheckStatus;
  readonly count: number;
  readonly difference: string | null;
  readonly findings: Finding[];
}

/**
 * Words for a ledger account kind: `gateway_clearing` is `Gateway clearing`.
 *
 * @param kind the account kind
 * @returns the kind in words, first letter in capitals
 */
export function kindInWords(kind: string): string {
  const words = kind.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The reference of an account finding.
 *
 * @param kind the account kind
 * @param ownerId the owner's id, or `null` for a system account
 * @returns `client_wallet:4`, or the bare kind for an account with no owner
 */
export function accountRef(kind: string, ownerId: number | null): string {
  return ownerId === null ? kind : `${kind}:${ownerId}`;
}

/**
 * The label of an account finding.
 *
 * @param kind the account kind
 * @param ownerId the owner's id, or `null` for a system account
 * @param ownerName the merchant's or supplier's name, when it is known
 * @returns `Wallet · <merchant>`, `Hold · <merchant>`, `Supplier prepaid · <supplier>`, or the kind in words
 */
export function accountLabel(kind: string, ownerId: number | null, ownerName: string | null): string {
  const owner = ownerName ?? (ownerId === null ? null : `#${ownerId}`);
  if (owner === null) return kindInWords(kind);
  if (kind === 'client_wallet') return `Wallet · ${owner}`;
  if (kind === 'client_hold') return `Hold · ${owner}`;
  if (kind === 'supplier_prepaid') return `Supplier prepaid · ${owner}`;
  return `${kindInWords(kind)} · ${owner}`;
}

/**
 * The label of an entry finding.
 *
 * @param kind the transaction kind (`deposit`, `order`, ...)
 * @param refType what the transaction points at
 * @param refId the id it points at
 * @returns `<kind> · <ref_type> #<ref_id>`, or `<kind> · system` for a system posting
 */
export function entryLabel(kind: string, refType: string, refId: number): string {
  return refType === 'system' ? `${kind} · system` : `${kind} · ${refType} #${refId}`;
}

/**
 * Builds the result of one check.
 *
 * @param key the check
 * @param count how many problems it found in all
 * @param findings the first {@link MAX_FINDINGS} of them
 * @param difference the sum of the differences of all of them (money checks), or `null`
 * @returns `pass` with a zero difference when nothing was found, `fail` otherwise
 */
export function checkResult(key: CheckKey, count: number, findings: Finding[], difference: string | null): CheckResult {
  const spec = CHECKS[key];
  return {
    key,
    label: spec.label,
    status: count === 0 ? 'pass' : 'fail',
    count,
    difference: spec.money ? (count === 0 ? '0.0000' : difference) : null,
    findings: findings.slice(0, MAX_FINDINGS),
  };
}

/**
 * The four checks of a run that never happened or did not finish.
 *
 * @returns the four checks in the map's order, each `unknown` with no findings
 */
export function unknownChecks(): CheckResult[] {
  return CHECK_KEYS.map((key) => ({
    key,
    label: CHECKS[key].label,
    status: 'unknown' as const,
    count: 0,
    difference: null,
    findings: [],
  }));
}

/**
 * The count the `ledger.mismatch_count` metric reads: the problems where the books disagree with themselves or with the payments.
 *
 * Why: scenario system-integrity step 2 fires the ledger mismatch rule when a wallet does not match its lines. An entry that does
 * not sum to zero, an account off from its lines and a confirmed payment with no entry are all the ledger disagreeing; a stuck
 * hold is a process delay with a console page of its own (the stuck-orders list), not a disagreement.
 *
 * @param checks the four checks of a run
 * @returns the number of findings of the three money checks
 */
export function mismatchCountOf(checks: readonly CheckResult[]): number {
  return checks.filter((check) => check.key !== 'stuck_holds').reduce((sum, check) => sum + check.count, 0);
}

/** The counters a run reports next to the nested checks (B99: counters stay top-level, details under `checks`). */
export interface IntegrityTotals {
  readonly accountsChecked: number;
  readonly entriesChecked: number;
  readonly transactionsChecked: number;
}

/**
 * The `result` stored on the `job_runs` row of a finished integrity run.
 *
 * @param checks the four checks
 * @param totals how much the run looked at
 * @returns top-level counters (what the jobs page prints) and the nested `checks` (what the integrity page reads)
 */
export function integrityResult(checks: readonly CheckResult[], totals: IntegrityTotals): Record<string, unknown> {
  const count = (key: CheckKey): number => checks.find((check) => check.key === key)?.count ?? 0;
  return {
    failedChecks: checks.filter((check) => check.status === 'fail').length,
    mismatchCount: mismatchCountOf(checks),
    accountsChecked: totals.accountsChecked,
    entriesChecked: totals.entriesChecked,
    transactionsChecked: totals.transactionsChecked,
    unbalancedEntries: count('entries_balanced'),
    accountDifferences: count('accounts_match_lines'),
    stuckHolds: count('stuck_holds'),
    paymentsWithoutEntry: count('payments_without_entry'),
    checks,
  };
}

/**
 * Reads the four checks back from a run's `result`.
 *
 * Why: the report shows the checks of the last finished run; a run that failed or was skipped has no `checks`, and a check
 * missing from the result reads `unknown`, never `pass`.
 *
 * @param result a `job_runs.result` (any shape)
 * @returns the four checks in the map's order
 */
export function checksFromResult(result: Record<string, unknown> | null | undefined): CheckResult[] {
  const stored = result?.checks;
  if (!Array.isArray(stored)) return unknownChecks();
  const byKey = new Map<string, CheckResult>();
  for (const item of stored as unknown[]) {
    if (typeof item === 'object' && item !== null && typeof (item as { key?: unknown }).key === 'string') {
      byKey.set((item as CheckResult).key, item as CheckResult);
    }
  }
  const unknown = unknownChecks();
  return CHECK_KEYS.map((key, index) => byKey.get(key) ?? (unknown[index] as CheckResult));
}

/**
 * Whether a finished run passed every check.
 *
 * @param status the run's status
 * @param result the run's `result`
 * @returns true for a succeeded run whose `failedChecks` is 0
 */
export function isCleanRun(status: string, result: Record<string, unknown> | null | undefined): boolean {
  return status === 'succeeded' && result?.failedChecks === 0;
}

/**
 * Whether a finished run counts toward the report's `lastRun`.
 *
 * Why: a run that was skipped because another was going on checked nothing; the run it made way for finishes and becomes the last
 * one, so showing the skipped one would only turn four known results into four unknown ones.
 *
 * @param status the run's status
 * @returns true unless the run was skipped
 */
export const countsAsLastRun = (status: string): boolean => status !== 'skipped';

/**
 * The overall verdict of a run's checks (`result` of the report, ANSWERS Q35).
 *
 * @param checks the four checks
 * @returns `fail` when any check failed, else `unknown` when any is unknown, else `pass`
 */
export function overallResult(checks: readonly CheckResult[]): CheckStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'unknown')) return 'unknown';
  return 'pass';
}
