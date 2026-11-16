// SearchReportService: the use case of `GET /admin/search/report` (feature 29, plan sections 5.1 and 6): what visitors searched for, from the
// daily counts. No address, user or session is in these rows; an IMEI, phone number, email or link was never counted.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../../common/clock';
import { DbService } from '../../../../infra/db';
import { dayOf } from '../domain/terms';
import { reportTotals, topTermRows, zeroResultTermRows } from '../infra/search-admin.repository';

/** The rows each table of the report holds at most. */
export const REPORT_ROWS = 50;
const DAY_MS = 86_400_000;

/** The report as the console reads it. */
export interface SearchReport {
  readonly days: number;
  readonly totals: { readonly searches: number; readonly zeroResults: number; readonly terms: number };
  readonly topTerms: Array<{ term: string; searches: number; visitors: number; zeroResults: number }>;
  readonly zeroResultTerms: Array<{ term: string; searches: number; lastSeen: string }>;
}

/**
 * Builds the search report.
 *
 * Why: staff add a synonym or a pin for a term that found nothing, and hide a term from the popular searches; this is where they see
 * them (owner questions 4 and 8).
 *
 * Side effects: reads `search_terms_daily` only.
 *
 * @see GET /admin/search/report
 */
@Injectable()
export class SearchReportService {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Reads the report of the last `days` days (today included).
   *
   * @param days 7, 30 or 90
   * @returns the totals, the top terms and the terms that found nothing
   */
  async report(days: number): Promise<SearchReport> {
    const since = dayOf(new Date(this.clock.nowMs() - (days - 1) * DAY_MS));
    const db = this.db.db;
    const [totals, top, zero] = await Promise.all([
      reportTotals(db, since),
      topTermRows(db, since, REPORT_ROWS),
      zeroResultTermRows(db, since, REPORT_ROWS),
    ]);
    return {
      days,
      totals,
      topTerms: top,
      zeroResultTerms: zero.map((row) => ({
        term: row.term,
        searches: row.searches,
        lastSeen: row.lastSeen.toISOString(),
      })),
    };
  }
}
