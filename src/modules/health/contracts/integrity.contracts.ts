// Route contracts of the money integrity check (map domain G, routes /admin/system/integrity*, feature 12b): the report and the manual run.
// Shapes match the console's `IntegrityReport` (docs/contract/endpoints/health.md; resolutions health-commissions-9, -16, ANSWERS system-health
// Q35, Q36, MISMATCHES B99).
import { z } from 'zod';
import { defineRoute, zId, zIsoDateTime, zMoney } from '../../../common/contract';
import { JobRunShape } from './system-ops.contracts';

const Finding = z.object({
  kind: z.enum(['entry', 'account', 'hold', 'payment']),
  id: zId,
  ref: z
    .string()
    .describe('`#<ledger_transactions.id>`, `<account kind>:<owner id>`, `#<order id>` or the gateway transaction id.'),
  label: z.string(),
  difference: zMoney.nullable(),
  ageSeconds: z.number().int().nullable(),
  lastEntryAt: zIsoDateTime.nullable(),
});

const Check = z.object({
  key: z.enum(['entries_balanced', 'accounts_match_lines', 'stuck_holds', 'payments_without_entry']),
  label: z.string(),
  status: z.enum(['pass', 'fail', 'unknown']),
  count: z.number().int().describe('The full number of findings.'),
  difference: zMoney
    .nullable()
    .describe('The sum of the differences of every finding; `null` for `stuck_holds` and for an unknown check.'),
  findings: z.array(Finding).describe('The first 20 findings.'),
});

/** The report of `GET /admin/system/integrity`. */
export const IntegrityReportShape = z.object({
  running: z.boolean().describe('True while a nightly or manual run is going.'),
  runningSince: zIsoDateTime.nullable().optional().describe('Extra field (always sent): when the running run started.'),
  lastRun: JobRunShape.nullable().describe('The newest run that is over (never the running one, never a skipped one).'),
  lastSuccessAt: zIsoDateTime.nullable().describe('When the newest run that passed every check finished.'),
  result: z
    .enum(['pass', 'fail', 'unknown'])
    .optional()
    .describe('Extra field (always sent): the worst of the four checks of `lastRun`.'),
  checks: z.array(Check).describe('The four checks of `lastRun`, in the map order.'),
});

const REPORT_EXAMPLE = {
  running: false,
  runningSince: null,
  lastRun: {
    id: 812,
    job: 'ledger_integrity',
    startedAt: '2026-11-07T02:30:00.000Z',
    finishedAt: '2026-11-07T02:30:02.000Z',
    durationMs: 2000,
    processed: 48,
    trigger: 'schedule',
    status: 'succeeded',
    error: null,
    result: { failedChecks: 0, mismatchCount: 0, accountsChecked: 48, entriesChecked: 3923 },
    triggeredBy: null,
  },
  lastSuccessAt: '2026-11-07T02:30:02.000Z',
  result: 'pass',
  checks: [
    {
      key: 'entries_balanced',
      label: 'Every entry sums to zero',
      status: 'pass',
      count: 0,
      difference: '0.0000',
      findings: [],
    },
    {
      key: 'accounts_match_lines',
      label: 'Every account balance equals the sum of its lines',
      status: 'pass',
      count: 0,
      difference: '0.0000',
      findings: [],
    },
    {
      key: 'stuck_holds',
      label: 'No hold is stuck for more than 24 hours',
      status: 'pass',
      count: 0,
      difference: null,
      findings: [],
    },
    {
      key: 'payments_without_entry',
      label: 'Every confirmed payment has an entry',
      status: 'pass',
      count: 0,
      difference: '0.0000',
      findings: [],
    },
  ],
} as const;

/** `GET /admin/system/integrity`. */
export const getIntegrity = defineRoute({
  key: 'GET /admin/system/integrity',
  summary: 'Money integrity report',
  description:
    'The four checks of the last finished run of the job `ledger_integrity` (nightly at 02:30 UTC and manual): every entry sums to zero, every account ' +
    'balance equals the sum of its lines (the same comparison as `POST /admin/ledger/reconcile`, debit-positive differences), no hold is stuck for more than ' +
    '24 hours, and every confirmed payment has an entry. Each check has a `status`, the full `count`, the summed `difference` and the first 20 findings with ' +
    'a label, a reference and, where it applies, the difference, the age or the time of the last entry. A check reads `unknown` when it never ran. The check ' +
    'only reads the ledger: a difference is put right with a reversing entry in Finance. During a database outage the route answers `503 DATABASE_UNAVAILABLE`.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:read',
  success: { status: 200, schema: IntegrityReportShape },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'DATABASE_UNAVAILABLE'],
  examples: { response: REPORT_EXAMPLE },
});

/** `POST /admin/system/integrity/run`. */
export const runIntegrityCheck = defineRoute({
  key: 'POST /admin/system/integrity/run',
  summary: 'Run the integrity check now',
  description:
    'Starts `ledger_integrity` as a background job: inserts a `job_runs` row (`trigger` manual, `running`, the staff member) and enqueues the job on the ' +
    '`maintenance` queue with the job id `manual-<run id>`. Answers `202` with the new run; the result appears in `GET /admin/system/integrity` when it ends. A run ' +
    'that finds no difference resolves the open `ledger.mismatch_count` alert. A nightly or manual run that is going is `409 JOB_ALREADY_RUNNING`. Writes the audit ' +
    'entry `ran job`. Nothing is ever corrected.',
  tags: ['system-health'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'system:manage',
  success: { status: 202, schema: JobRunShape },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'JOB_ALREADY_RUNNING', 'UNAVAILABLE', 'DATABASE_UNAVAILABLE'],
  examples: {
    response: {
      id: 813,
      job: 'ledger_integrity',
      startedAt: '2026-11-07T09:00:00.000Z',
      finishedAt: null,
      durationMs: 0,
      processed: 0,
      trigger: 'manual',
      status: 'running',
      error: null,
      result: {},
      triggeredBy: { id: 1, name: 'Rami K.' },
    },
  },
});
