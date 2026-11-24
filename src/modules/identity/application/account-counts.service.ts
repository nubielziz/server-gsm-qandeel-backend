// AccountCountsService: the numbers of the Accounts page (GET /admin/clients/counts).
import { Injectable } from '@nestjs/common';
import { DbService } from '../../../infra/db';
import { RankGroupReads } from '../../catalog/ports/rank-group-reads';
import { type AccountCounts, countAccounts } from '../infra/account-counts.repository';

/**
 * Counts accounts for the chips and the header sentence of the Accounts page.
 *
 * Why: the page shows how many accounts of each rank kind and status exist whatever the toolbar says, so the numbers come from one
 * aggregate over every row, never from the page being listed (decision 064). Nothing is cached: the counts must agree with the list a
 * moment later.
 *
 * Side effects: none (reads only).
 *
 * @see GET /admin/clients/counts
 */
@Injectable()
export class AccountCountsService {
  constructor(
    private readonly db: DbService,
    private readonly ranks: RankGroupReads,
  ) {}

  /**
   * Counts the accounts.
   *
   * @returns every number of the page: all, retail, merchant, guests, one per status, and invitations pending
   */
  async counts(): Promise<AccountCounts> {
    const db = this.db.db;
    return countAccounts(db, await this.ranks.retailGroupId(db));
  }
}
