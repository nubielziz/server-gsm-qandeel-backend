// Ledger reconciliation (map route POST /admin/ledger/reconcile, scenario system-integrity): compares each account's stored
// balance with the sum of its entries, records the run in job_runs and audits it. Read-only: it never corrects anything.
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { JobRunsService } from '../../health';
import { AuditService } from '../../platform';
import type { ReconcileReportSchema } from '../contracts/ledger.contracts';
import { toDebitPositive } from '../domain/accounts';
import { loadOwnerNames, ownerKey } from '../infra/foreign-directory.repository';
import { countLedger, findBalanceDifferences } from '../infra/ledger-read.repository';

/** The job name of a reconciliation in `job_runs`. */
export const LEDGER_RECONCILE_JOB = 'ledger_reconcile';

/** The report of a reconciliation on the wire (`ReconcileResult` of the console). */
export type ReconcileReport = z.output<typeof ReconcileReportSchema>;

/**
 * Compares every account's stored balance with the sum of its entries, in one snapshot.
 *
 * Why: scenario system-integrity steps 1 and 2. It is a plain function so the health module's nightly integrity check can call it through a
 * late import of money's index (decision 032: a provider of money cannot be built from the health module), and so `ReconcileService.compare`
 * and the integrity job answer from one query. It only reads.
 *
 * @param db the database service (it opens the transaction)
 * @param ranAt the time to report
 * @returns when it ran, how much it checked and the accounts that differ (debit-positive amounts)
 */
export async function compareLedgerBalances(db: DbService, ranAt: Date): Promise<ReconcileReport> {
  // Repeatable read: the two counts and the comparison describe one instant even while postings go on.
  return db.runInTransaction(
    async ({ tx }) => {
      const [totals, differences] = [await countLedger(tx), await findBalanceDifferences(tx)];
      const names = await loadOwnerNames(
        tx,
        differences.flatMap((row) =>
          row.ownerType !== null && row.ownerId !== null ? [{ ownerType: row.ownerType, ownerId: row.ownerId }] : [],
        ),
      );
      return {
        ranAt: ranAt.toISOString(),
        accountsChecked: totals.accounts,
        entriesChecked: totals.entries,
        differences: differences.map((row) => {
          const stored = toDebitPositive(row.kind, Money.of(row.stored));
          const expected = toDebitPositive(row.kind, Money.of(row.expected));
          return {
            accountId: row.accountId,
            kind: row.kind,
            ownerName:
              row.ownerType !== null && row.ownerId !== null
                ? (names.get(ownerKey(row.ownerType, row.ownerId)) ?? null)
                : null,
            stored: stored.toWire(),
            expected: expected.toWire(),
            difference: stored.sub(expected).toWire(),
          };
        }),
      };
    },
    { isolation: 'repeatable read' },
  );
}

/**
 * Runs the reconciliation.
 *
 * Why: scenario system-integrity steps 1, 3 and 6: "sum of entries per account = balance". The route is synchronous (ANSWERS
 * finance Q4): the comparison is aggregate SQL, and a second run while one is going on answers `RECONCILE_RUNNING`. The run is
 * a `job_runs` row of the job `ledger_reconcile` (decision 020) so the System health jobs list shows it; the nightly integrity
 * job of the health feature can reuse {@link ReconcileService.compare}.
 *
 * Side effects: inserts and closes a `job_runs` row; writes one audit row.
 */
@Injectable()
export class ReconcileService {
  constructor(
    private readonly db: DbService,
    private readonly jobRuns: JobRunsService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Runs the reconciliation for a staff member.
   *
   * @param staffId the staff member who started it
   * @returns when it ran, how much it checked and the accounts that differ (debit-positive amounts)
   * @throws {AppError} `RECONCILE_RUNNING` when another run is going on
   */
  async run(staffId: number): Promise<ReconcileReport> {
    const ranAt = this.clock.now();
    const run = await this.start(staffId);
    let report: ReconcileReport;
    try {
      report = await this.compare(ranAt);
    } catch (error) {
      await this.jobRuns.finish(run.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    await this.jobRuns.finish(run.id, {
      status: 'succeeded',
      processed: report.accountsChecked,
      result: {
        accountsChecked: report.accountsChecked,
        entriesChecked: report.entriesChecked,
        differences: report.differences.length,
      },
    });
    await this.db.runInTransaction(({ tx }) =>
      this.audit.record(tx, {
        action: 'ran',
        entityType: 'ledger_transaction',
        entityLabel: 'the ledger reconciliation',
        after: {
          accountsChecked: report.accountsChecked,
          entriesChecked: report.entriesChecked,
          differences: report.differences.length,
        },
      }),
    );
    return report;
  }

  /**
   * Compares the stored balances with the entries, in one snapshot.
   *
   * @param ranAt the time to report
   * @returns the report
   */
  compare(ranAt: Date): Promise<ReconcileReport> {
    return compareLedgerBalances(this.db, ranAt);
  }

  private async start(staffId: number) {
    try {
      return await this.jobRuns.start({
        job: LEDGER_RECONCILE_JOB,
        trigger: 'manual',
        triggeredBy: staffId,
        overlap: 'refuse',
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'JOB_ALREADY_RUNNING') {
        throw new AppError('RECONCILE_RUNNING', { detail: 'A reconciliation is already running.' });
      }
      throw error;
    }
  }
}
