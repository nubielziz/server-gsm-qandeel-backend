// Logic of the deviation allowlist (test/contract/allowlist.ts): which findings an entry accepts, and which entries are
// invalid or stale. Kept apart from the data so that it can be unit-tested with entries of its own.
import type { Finding, Part } from './compare-route';
import type { Rule } from './compare';

/**
 * One accepted deviation.
 *
 * Why: a deviation between the frontend and the backend is never picked silently (CLAUDE.md): it names the route, the
 * part and path where it shows, the rule that fires, and the B-id of `docs/contract/MISMATCHES.md` that records the
 * decision.
 */
export interface AllowlistEntry {
  /** Manifest key of the route. */
  readonly route: string;
  /** Which part of the exchange (default `response`). */
  readonly part?: Part;
  /** Path of the difference, as the failure message prints it (`data[].status`). */
  readonly path: string;
  readonly rule: Rule;
  /** The decision record: `B12`. Must exist in MISMATCHES.md. */
  readonly mismatch: string;
  /** One sentence: why the deviation is accepted. */
  readonly reason: string;
}

/** Does the entry accept the finding? Only errors need an entry; infos never fail. */
export function accepts(entry: AllowlistEntry, finding: Finding): boolean {
  return (
    finding.severity === 'error' &&
    entry.route === finding.route &&
    (entry.part ?? 'response') === finding.part &&
    entry.path === finding.path &&
    entry.rule === finding.rule
  );
}

/** What is left after the allowlist is applied. */
export interface Reconciliation {
  /** Errors no entry accepts: the test failures. */
  readonly unexpected: readonly Finding[];
  /** Entries that matched no error: the deviation is gone, so the entry must be deleted. */
  readonly stale: readonly AllowlistEntry[];
}

/**
 * Applies the allowlist to the findings of a run.
 *
 * Why: the list must not rot: an entry that matches nothing fails, so a fixed deviation cannot stay accepted.
 *
 * @param findings all findings of the run
 * @param entries the allowlist
 * @returns the unaccepted errors and the stale entries
 */
export function reconcile(findings: readonly Finding[], entries: readonly AllowlistEntry[]): Reconciliation {
  const unexpected = findings.filter(
    (finding) => finding.severity === 'error' && !entries.some((e) => accepts(e, finding)),
  );
  const stale = entries.filter((entry) => !findings.some((finding) => accepts(entry, finding)));
  return { unexpected, stale };
}

/**
 * Checks the entries themselves: a known rule, an existing B-id, a reason, no duplicates.
 *
 * @param entries the allowlist
 * @param mismatchIds the `B<n>` ids of MISMATCHES.md
 * @param rules the rule names the comparator knows
 * @returns one message per problem; empty when the list is sound
 */
export function validateEntries(
  entries: readonly AllowlistEntry[],
  mismatchIds: ReadonlySet<string>,
  rules: readonly string[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = `${entry.route} [${entry.part ?? 'response'}] ${entry.path} (${entry.rule})`;
    if (!mismatchIds.has(entry.mismatch))
      problems.push(`${name}: "${entry.mismatch}" is not a B-id in docs/contract/MISMATCHES.md`);
    if (!rules.includes(entry.rule)) problems.push(`${name}: unknown rule "${entry.rule}"`);
    if (entry.reason.trim().length < 10) problems.push(`${name}: give a reason`);
    if (seen.has(name)) problems.push(`${name}: listed twice`);
    seen.add(name);
  }
  return problems;
}
