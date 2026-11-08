// ClientStatementService: makes the official account statement PDF of a merchant (route GET /admin/reports/client-statement/:clientId,
// stage 11). Reads the wallet ledger in one snapshot, draws it with the platform's PdfRenderer and writes an audit row.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { type DbExecutor, DbService } from '../../../infra/db';
import { AuditService, PdfRenderer } from '../../platform';
import { BASE_CURRENCY } from '../domain/accounts';
import { type StatementData, statementDocument, statementFilename, statementTotals } from '../domain/client-statement';
import { dayWindow, isOrderedRange } from '../domain/report-figures';
import {
  listInvoicesBetween,
  listWalletLinesBetween,
  walletBalanceBeforeEntry,
  walletBalanceBeforeMoment,
} from '../infra/client-statement.repository';
import { findStatementMerchant } from '../infra/foreign-directory.repository';
import { type StatementEntryRow, readWalletAccounts } from '../infra/ledger-read.repository';

/** The most wallet lines (and the most invoices) one statement holds; an explicit period with more must be narrowed. */
export const STATEMENT_PDF_MAX_ROWS = 10_000;

/** The file the route answers. */
export interface StatementFile {
  /** The name for `Content-Disposition`. */
  readonly filename: string;
  /** The PDF. */
  readonly bytes: Uint8Array;
}

/**
 * Renders the client statement.
 *
 * Why: the console's merchant page downloads "the official statement" accountants keep (contract money.md). Figures come straight from
 * the ledger accounts and lines in one read-only repeatable-read transaction, never from a cache (decision 022), so the opening
 * balance, the lines and the closing balance describe one moment. The PDF is built in memory, sent whole (not streamed) and not
 * stored (decision 030). Days are UTC days like the other reports (ANSWERS finance Q7). Lines are ordered, and the opening balance is
 * found, by ledger entry id (the order `balance_after` follows), so the closing balance is the wallet's balance even when two
 * postings carry clock times out of id order. The default period is the whole history, from the day of the wallet's first line to
 * today; a history longer than the cap (lines or invoices) is cut to its most recent rows (the console sends no period and must never
 * get a 422).
 *
 * Side effects: one `audit_logs` row (`exported statement of`), written in its own short transaction after the reads. Nothing else is
 * written.
 */
@Injectable()
export class ClientStatementService {
  constructor(
    private readonly db: DbService,
    private readonly pdf: PdfRenderer,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Makes the statement of a merchant.
   *
   * @param clientId the merchant
   * @param query the optional first and last day (`YYYY-MM-DD`, both included); a missing `to` is today, a missing `from` the day of
   *   the first wallet line, or, when the history holds more than `maxRows` lines, the day of the first of the most recent
   *   `maxRows` lines (the opening balance is the balance before that line); without `from` the invoices are cut the same way, to the
   *   newest `maxRows`
   * @param maxRows the most lines (or invoices) a statement holds; the route never changes the default, a test lowers it
   * @returns the file name and the PDF bytes
   * @throws {AppError} `VALIDATION_FAILED` (422 on `from`) when `from` is after `to`, or when an explicit `from` period holds more
   *   than `maxRows` lines or more than `maxRows` invoices (a request without `from` is never refused for size); `NOT_FOUND` when
   *   there is no merchant with this id
   */
  async render(
    clientId: number,
    query: { from?: string | undefined; to?: string | undefined },
    maxRows = STATEMENT_PDF_MAX_ROWS,
  ): Promise<StatementFile> {
    const now = this.clock.now();
    const today = now.toISOString().slice(0, 10);
    const to = query.to ?? today;
    if (query.from !== undefined && !isOrderedRange(query.from, to)) {
      throw invalid('The first day must not be after the last day.');
    }

    const data = await this.read(clientId, query.from, to, now, maxRows);
    const bytes = await this.pdf.render(statementDocument(data));

    const totals = statementTotals(data.opening, data.lines);
    await this.db.runInTransaction(({ tx }) =>
      this.audit.record(tx, {
        // The demo has no statement export; this follows its 'exported data of' (customer) phrase.
        action: 'exported statement of',
        entityType: 'merchant',
        entityId: clientId,
        entityLabel: data.merchant.name,
        after: {
          from: data.from,
          to: data.to,
          lines: data.lines.length,
          invoices: data.invoices.length,
          opening: data.opening,
          closing: totals.closing.toWire(),
        },
      }),
    );
    return { filename: statementFilename(clientId, data.from, data.to), bytes };
  }

  /** Reads everything the statement shows in one read-only snapshot. */
  private read(
    clientId: number,
    from: string | undefined,
    to: string,
    now: Date,
    maxRows: number,
  ): Promise<StatementData> {
    return this.db.runInTransaction(
      async ({ tx }): Promise<StatementData> => {
        const merchant = await findStatementMerchant(tx, clientId);
        if (!merchant) throw new AppError('NOT_FOUND', { detail: 'No merchant with this id.' });
        const accounts = await readWalletAccounts(tx, clientId, BASE_CURRENCY);
        const { end } = dayWindow(to, to);
        const { lines, start } = await readLines(tx, accounts.walletId, from, to, maxRows);
        const { start: begin } = dayWindow(start, to);

        // Without `from` the newest `maxRows` invoices are kept, the way the lines are cut; an explicit period must fit.
        const invoices = await listInvoicesBetween(
          tx,
          clientId,
          begin,
          end,
          from === undefined ? maxRows : maxRows + 1,
          from === undefined,
        );
        if (invoices.length > maxRows) throw invalid(`The period holds more than ${maxRows} invoices; narrow it.`);
        const first = lines[0];
        // The balance before the first line shown (by entry id), so opening + lines always ends on the wallet's own balance_after.
        const opening =
          accounts.walletId === undefined
            ? '0.0000'
            : first
              ? await walletBalanceBeforeEntry(tx, accounts.walletId, first.id)
              : await walletBalanceBeforeMoment(tx, accounts.walletId, begin);
        return {
          merchant,
          from: start,
          to,
          opening,
          lines,
          creditLimit: accounts.creditLimit,
          invoices,
          createdAt: now,
        };
      },
      { isolation: 'repeatable read', readOnly: true },
    );
  }
}

/**
 * Reads the wallet lines a statement shows and the first day of its period.
 *
 * Why: with an explicit `from` the period is the caller's and a longer one is refused; without `from` the whole history is wanted and a
 * history longer than `maxRows` is cut to its newest lines instead (the console sends no period and must get a statement, not a 422).
 *
 * @param tx the statement's transaction
 * @param walletId the merchant's `client_wallet` account, `undefined` when the merchant has none
 * @param from the explicit first day, if the caller sent one
 * @param to the last day
 * @param maxRows the most lines a statement holds
 * @returns the lines in entry id order and the first day of the period (`YYYY-MM-DD`)
 * @throws {AppError} `VALIDATION_FAILED` when an explicit period holds more than `maxRows` lines
 */
async function readLines(
  tx: DbExecutor,
  walletId: number | undefined,
  from: string | undefined,
  to: string,
  maxRows: number,
): Promise<{ lines: StatementEntryRow[]; start: string }> {
  const { end } = dayWindow(to, to);
  if (from === undefined) {
    const lines = walletId === undefined ? [] : await listWalletLinesBetween(tx, walletId, undefined, end, maxRows);
    // The earliest day among the lines shown: the day of the first line, unless a clock was out of id order. `to` when there are none.
    const start = lines.map((line) => line.createdAt.toISOString().slice(0, 10)).reduce((a, b) => (a < b ? a : b), to);
    return { lines, start };
  }
  const lines =
    walletId === undefined
      ? []
      : await listWalletLinesBetween(tx, walletId, dayWindow(from, to).start, end, maxRows + 1);
  if (lines.length > maxRows) throw invalid(`The period holds more than ${maxRows} lines; narrow it.`);
  return { lines, start: from };
}

function invalid(message: string): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field: 'from', code: 'invalid_range', message }] });
}
