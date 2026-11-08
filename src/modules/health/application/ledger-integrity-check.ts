// The money integrity check of the nightly and the manual run (job `ledger_integrity`, scenario system-integrity steps 1, 2 and 7): the four
// checks of the console's Integrity tab. It reuses money's account comparison and never corrects anything.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import {
  type CheckResult,
  type Finding,
  type IntegrityTotals,
  accountLabel,
  accountRef,
  checkResult,
  entryLabel,
} from '../domain/integrity';
import {
  accountFacts,
  countTransactions,
  paymentsWithoutEntry,
  stuckHolds,
  unbalancedEntries,
} from '../infra/integrity-reads.repository';
import { money } from '../infra/sibling-modules';

/** What one run of the check found. */
export interface IntegrityOutcome {
  readonly checks: CheckResult[];
  readonly totals: IntegrityTotals;
}

/**
 * Runs the four money integrity checks.
 *
 * Why: the nightly job and `POST /admin/system/integrity/run` both end here. The checks only read: a difference is put right by a staff
 * member with a reversing entry in Finance (scenario system-integrity step 3), never by this job (decision 024). The account comparison is
 * money's `compareLedgerBalances`, loaded late (decision 032: money imports this module's job runs, so a static import would meet money's index
 * half-initialised); it is a plain function, so no money provider is built here.
 *
 * Side effects: reads the ledger, orders and payments; no writes (the processor records the run in `job_runs`).
 *
 * @see docs/contract/endpoints/health.md (GET /admin/system/integrity)
 */
@Injectable()
export class LedgerIntegrityCheck {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs the checks.
   *
   * @returns the four checks in the map's order and how much was looked at
   * @throws whatever the database or the comparison throws: the run is then recorded as failed and the console shows every check `unknown`
   */
  async run(): Promise<IntegrityOutcome> {
    const now = this.clock.now();
    const db = this.db.db;
    const { compareLedgerBalances } = await money();
    const [report, entries, transactions, holds, payments] = await Promise.all([
      compareLedgerBalances(this.db, now),
      unbalancedEntries(db),
      countTransactions(db),
      stuckHolds(db, now),
      paymentsWithoutEntry(db),
    ]);

    const entryFindings: Finding[] = entries.rows.map((row) => ({
      kind: 'entry',
      id: row.id,
      ref: `#${row.id}`,
      label: entryLabel(row.kind, row.refType, row.refId),
      difference: row.difference,
      ageSeconds: null,
      lastEntryAt: null,
    }));

    const shown = report.differences.slice(0, 20);
    const facts = await accountFacts(
      db,
      shown.map((row) => row.accountId),
    );
    const accountFindings: Finding[] = shown.map((row) => {
      const fact = facts.get(row.accountId);
      const ownerId = fact?.ownerId ?? null;
      return {
        kind: 'account',
        id: row.accountId,
        ref: accountRef(row.kind, ownerId),
        label: accountLabel(row.kind, ownerId, row.ownerName),
        difference: row.difference,
        ageSeconds: null,
        lastEntryAt: fact?.lastEntryAt?.toISOString() ?? null,
      };
    });
    const accountsDifference = Money.sum(report.differences.map((row) => Money.fromWire(row.difference))).toWire();

    const holdFindings: Finding[] = holds.rows.map((row) => ({
      kind: 'hold',
      id: row.orderId,
      ref: `#${row.orderId}`,
      label: `Order #${row.orderId} · ${row.merchantName}`,
      difference: null,
      ageSeconds: Math.max(0, Math.floor((now.getTime() - row.heldAt.getTime()) / 1000)),
      lastEntryAt: null,
    }));

    const paymentFindings: Finding[] = payments.rows.map((row) => ({
      kind: 'payment',
      id: row.id,
      ref: row.gatewayTxnId ?? `#${row.id}`,
      label: `Payment · ${row.gatewayName}`,
      difference: row.amount,
      ageSeconds: null,
      lastEntryAt: null,
    }));

    return {
      checks: [
        checkResult('entries_balanced', entries.total, entryFindings, entries.difference),
        checkResult('accounts_match_lines', report.differences.length, accountFindings, accountsDifference),
        checkResult('stuck_holds', holds.total, holdFindings, null),
        checkResult('payments_without_entry', payments.total, paymentFindings, payments.difference),
      ],
      totals: {
        accountsChecked: report.accountsChecked,
        entriesChecked: report.entriesChecked,
        transactionsChecked: transactions,
      },
    };
  }
}
