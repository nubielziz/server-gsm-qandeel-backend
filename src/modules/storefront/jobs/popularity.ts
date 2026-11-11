// PopularityRefresh: refreshes service_listings.sales_30d from the orders of the last 30 days (storefront module, queue maintenance,
// job storefront_popularity; feature 22, slice B).
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { salesCountsByService } from '../infra/foreign-reads.repository';

/** The window of the best-seller order, in days. */
export const POPULARITY_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** What one refresh did. */
export interface PopularityResult {
  /** services with at least one order in the window */
  readonly services: number;
  /** listing rows whose `sales_30d` changed */
  readonly changed: number;
}

/**
 * Stores the 30-day order count of every service on its listing rows.
 *
 * Why: feature 22, "best sellers" sort of the storefront (`_sort=popular`). The count is stored, not computed per request, so the public
 * list sorts by a plain column. Every non-rejected order of every channel counts (`salesCountsByService`, a documented foreign read); only the order of the list leaks,
 * never the number (the card has no such field).
 *
 * Idempotent and safe to run in parallel: one statement sets each row to the freshly counted value and writes only rows whose value
 * differs, so a repeat changes nothing; it never touches `updated_at` (a refresh is not a content edit). The rows it writes are locked in
 * id order (`order by id for update`), the order every listing writer uses, so it cannot deadlock with a staff edit; it never takes the
 * service row lock.
 *
 * Side effects: updates `service_listings.sales_30d` (and nothing else).
 */
@Injectable()
export class PopularityRefresh {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Recounts the last 30 days and updates the listings.
   *
   * @returns how many services had orders and how many listing rows changed
   */
  async refresh(): Promise<PopularityResult> {
    const since = new Date(this.clock.nowMs() - POPULARITY_WINDOW_DAYS * DAY_MS);
    const counts = await salesCountsByService(this.db.db, since);
    // One JSON parameter instead of two arrays: Drizzle expands a JS array into a tuple of placeholders, not an array value.
    const rows = JSON.stringify([...counts].map(([serviceId, n]) => ({ service_id: serviceId, n })));
    const result = await this.db.db.execute(sql`
      update service_listings l set sales_30d = v.n
        from (select l2.id, coalesce(c.n, 0) as n
                from service_listings l2
                left join jsonb_to_recordset(${rows}::jsonb) as c(service_id bigint, n int) on c.service_id = l2.service_id
               where l2.sales_30d is distinct from coalesce(c.n, 0)
               order by l2.id
                 for update of l2) v
       where l.id = v.id`);
    return { services: counts.size, changed: result.rowCount ?? 0 };
  }
}
