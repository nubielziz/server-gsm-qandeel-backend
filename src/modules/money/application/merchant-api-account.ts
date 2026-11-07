// MerchantApiAccount: what the machine surfaces say about a merchant's account (map domain E, stage 7): the wallet and group of `GET
// /v1/account`, the cursor statement of `GET /v1/transactions` and Dhru's `accountinfo`.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type z } from 'zod';
import { cutPage, decodeCursor } from '../../../common/contract';
import { DhruGateway } from '../../../common/dhru';
import { AppError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import type { getV1Account, listV1Transactions } from '../contracts/v1-account.contracts';
import { dhruAccountInfo } from '../contracts/v1-account.contracts';
import { BASE_CURRENCY } from '../domain/accounts';
import { findMerchantProfile } from '../infra/foreign-directory.repository';
import { listAccountEntriesBefore, readWalletAccounts } from '../infra/ledger-read.repository';
import { WalletService } from './wallet.service';

/** The account as REST v1 reads it. */
export type ApiAccountView = z.output<(typeof getV1Account)['success']['schema']>;
/** A page of the statement as REST v1 reads it. */
export type ApiTransactionsView = z.output<(typeof listV1Transactions)['success']['schema']>;

/**
 * Serves the account reads of REST v1 and Dhru.
 *
 * Why: the map's `GET /v1/account`, `GET /v1/transactions` and `accountinfo` rows: a merchant's integration reads the balance it may
 * spend and its statement without the portal. The figures are the ledger's own (never cached, decision 022): the same wallet view as
 * the portal, so the two never disagree. The statement pages by the id of the ledger entry (newest first), so a line that arrives while
 * the merchant pages never repeats or skips one. Dhru's `credit` is the available balance (balance plus credit limit), what an order
 * may spend now.
 *
 * Side effects: none (reads only); it binds the `accountinfo` handler to the Dhru gateway at start.
 *
 * @see docs/decisions/026-dhru-compatibility.md
 */
@Injectable()
export class MerchantApiAccount implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly wallets: WalletService,
    private readonly gateway: DhruGateway,
  ) {}

  /** Binds `accountinfo` to the Dhru gateway. */
  onModuleInit(): void {
    this.gateway.bind(dhruAccountInfo, async ({ caller }) => {
      const { credit, mail, currency } = await this.accountInfo(caller.clientId);
      return { message: 'Your Accout Info' as const, AccoutInfo: { credit, mail, currency } };
    });
  }

  /**
   * The wallet and the client group of a merchant.
   *
   * @param clientId the merchant behind the API key
   * @returns the four wallet figures, the currency and the group
   * @throws {AppError} `UNAUTHORIZED` when the merchant no longer exists
   */
  async account(clientId: number): Promise<ApiAccountView> {
    const [profile, wallet] = await Promise.all([
      findMerchantProfile(this.db.db, clientId),
      this.wallets.viewOf(this.db.db, clientId),
    ]);
    if (!profile) throw new AppError('UNAUTHORIZED');
    return { ...wallet, currency: BASE_CURRENCY, group: profile.group };
  }

  /**
   * The available balance, email and currency of a merchant (Dhru `accountinfo`).
   *
   * @param clientId the merchant behind the API key
   * @returns what the merchant may spend, its email and the currency
   * @throws {AppError} `UNAUTHORIZED` when the merchant no longer exists
   */
  async accountInfo(clientId: number): Promise<{ credit: string; mail: string; currency: string }> {
    const [profile, wallet] = await Promise.all([
      findMerchantProfile(this.db.db, clientId),
      this.wallets.viewOf(this.db.db, clientId),
    ]);
    if (!profile) throw new AppError('UNAUTHORIZED');
    return { credit: wallet.available, mail: profile.email, currency: BASE_CURRENCY };
  }

  /**
   * A page of the merchant's statement, newest first.
   *
   * @param clientId the merchant behind the API key
   * @param query the page size and the cursor of the previous page
   * @returns the lines and the cursor of the next page (`null` on the last)
   * @throws {AppError} `VALIDATION_FAILED` on `cursor` when it is not one of this list's
   */
  async transactions(
    clientId: number,
    query: { readonly limit: number; readonly cursor?: string | undefined },
  ): Promise<ApiTransactionsView> {
    const before = query.cursor === undefined ? undefined : decodeCursor(query.cursor, ['number'] as const)[0];
    const { walletId } = await readWalletAccounts(this.db.db, clientId, BASE_CURRENCY);
    if (walletId === undefined) return { data: [], nextCursor: null };
    const rows = await listAccountEntriesBefore(this.db.db, walletId, query.limit + 1, before);
    const page = cutPage(rows, query.limit, (row) => [row.id]);
    return {
      data: page.data.map((row) => ({
        id: row.id,
        transactionId: row.transactionId,
        kind: row.kind,
        memo: row.memo,
        // The wallet is credit-normal: the entry is debit positive, the merchant reads it from its own side.
        amount: Money.of(row.amount).neg().toWire(),
        balanceAfter: row.balanceAfter,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }
}
