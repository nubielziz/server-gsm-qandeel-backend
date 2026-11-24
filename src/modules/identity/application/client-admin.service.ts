// ClientAdminService: the reads of the staff routes on accounts (map domain A): the one list of every rank, one account, and the lookup of an
// old merchant or customer number. The writes (make an account, edit, status) are `ClientWriteService`; the counts are
// `AccountCountsService`.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { RankGroupReads } from '../../catalog/ports/rank-group-reads';
import { LegacyAccounts, legacySpaceOf } from '../accounts/legacy-accounts';
import { type AccountSortField, listClientRows } from '../infra/client-admin.repository';
import { AccountListSql } from '../ports/account-list-sql';
import { requirePermission } from '../security/principal';
import type { StaffPrincipal } from '../security/principal';
import { type AccountView, ClientViews } from './client-views';
import { MERCHANT_MAIL_EVENTS } from './mail/merchant-mail-outbox';

/**
 * The outbox event written when a merchant is invited; ids only, never the token (RESOLUTIONS identity-platform-2).
 *
 * Why: kept here, where the barrel and the invitation tests already look for it, until the account mails name their own events.
 */
export const MERCHANT_INVITED_EVENT = MERCHANT_MAIL_EVENTS.invited;

/**
 * Reads accounts for the console.
 *
 * Why: merchants, shop customers and guests are one table (decision 064), so one list serves every rank. No filter by rank kind means every
 * account. The row is the same for every caller with `clients:read`; the wallet, the 30-day figures and the sort by balance need
 * `wallet:read` too. The order count, the date of the last order and the wallet balance are SQL fragments the orders and money modules
 * register with `AccountListSql`, so a sort by them is one query, never a read per row.
 *
 * Side effects: none (reads only).
 *
 * @see docs/contract/endpoints/identity.md (the `/admin/clients` sections)
 */
@Injectable()
export class ClientAdminService {
  constructor(
    private readonly db: DbService,
    private readonly views: ClientViews,
    private readonly listSql: AccountListSql,
    private readonly ranks: RankGroupReads,
    private readonly legacy: LegacyAccounts,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Lists accounts.
   *
   * @param caller the signed-in staff member (wallet and stats are sent only with `wallet:read`)
   * @param query the parsed list request
   * @returns the page and the exact total
   * @throws {AppError} `FORBIDDEN` (403) for the sort by `balance` without `wallet:read`
   */
  async list(
    caller: StaffPrincipal,
    query: ParsedListQuery<AccountSortField>,
  ): Promise<{ rows: AccountView[]; total: number }> {
    // The balance is a finance figure: a caller who may not read wallets may not order by it either (it would leak the order).
    if (query.sort.some((key) => key.field === 'balance')) requirePermission(caller, 'wallet:read');
    const db = this.db.db;
    const [retailGroupId, rankOrder] = await Promise.all([
      query.filters.some((filter) => filter.field === 'rankKind') ? this.ranks.retailGroupId(db) : undefined,
      query.sort.some((key) => key.field === 'rank') ? this.ranks.rankOrder(db) : undefined,
    ]);
    const { rows, total } = await listClientRows(db, query, this.clock.now(), {
      listSql: this.listSql,
      retailGroupId,
      rankOrder,
    });
    return { rows: await this.views.many(db, caller, rows), total };
  }

  /**
   * Shows one account, of any rank and any status.
   *
   * @param caller the signed-in staff member
   * @param id the account id
   * @returns the account
   * @throws {AppError} `NOT_FOUND` (404)
   */
  show(caller: StaffPrincipal, id: number): Promise<AccountView> {
    return this.views.one(this.db.db, caller, id);
  }

  /**
   * Finds the account an old merchant or customer number belongs to.
   *
   * Why: an old customer number is never an account id (every customer got a new one), so the console resolves old numbers here instead of
   * guessing; `account` is not an old number, and the answer for it is the same as for a number nobody had.
   *
   * @param type `client` or `merchant` (an old merchant number) or `customer` (an old customer number)
   * @param id the old number
   * @returns the account id
   * @throws {AppError} `NOT_FOUND` (404) for an unknown number and for any other `type`
   */
  async legacyAccount(type: string, id: number): Promise<{ accountId: number }> {
    const space = legacySpaceOf(type);
    const accountId =
      space === undefined || space === 'self' ? undefined : await this.legacy.resolve(this.db.db, space, id);
    if (accountId === undefined) throw new AppError('NOT_FOUND', { detail: 'No account has this old number.' });
    return { accountId };
  }
}
