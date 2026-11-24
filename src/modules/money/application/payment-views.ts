// PaymentViews: builds the wire of a page of top-up payments: one query per kind of thing around them (accounts, groups, wallets,
// gateways, reviewers), never one per row.
import { Injectable } from '@nestjs/common';
import { type CustomerContact, customerEmailIn } from '../../../common/customer-contact';
import type { DbExecutor } from '../../../infra/db';
import { ClientGroupDirectory } from '../../catalog';
import { topUpOwnerWord } from '../domain/payment-rules';
import { newestDisputesOf } from '../infra/dispute.repository';
import { loadActorNames, loadBillingMerchants, ownerKey } from '../infra/foreign-directory.repository';
import { findGatewaysByIds } from '../infra/gateway.repository';
import { type PaymentRow, accountsWithApprovedTopup } from '../infra/payment.repository';
import { AccountWallets, type AccountWalletKind, type AccountWalletView } from '../ports/account-wallets';
import { type WirePayment, paymentToWire } from './billing-wire';

/** The balance of a wallet view when the wallet is of the kind the row names; a wallet of the other kind is not the one this top-up fills. */
function balanceOf(view: AccountWalletView | undefined, kind: AccountWalletKind): string | null {
  return view !== undefined && view.kind === kind ? view.balance : null;
}

/**
 * Turns payment rows into the console's `Payment`.
 *
 * Why: the Deposits tab shows the account that topped up (a `client` join for the merchant wallet, a `customer` join for the store
 * balance, both carrying the account id: decision 064), its group and current wallet balance, the gateway and the reviewer next to each
 * payment, and the newest chargeback of the top-up (money.md `GET /admin/payments`), so a page needs five reads around the rows; they are
 * batched here and shared by the list, the single read and the answers of approve and reject. Which join a row takes is the wallet kind
 * of its invoice. The wallet balance is read from the ledger accounts each time (never cached: money, decision 022), through
 * `AccountWallets`, which answers the live wallet: a row whose wallet is not the live one (the account changed kind since) shows no balance.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class PaymentViews {
  constructor(
    private readonly wallets: AccountWallets,
    private readonly groups: ClientGroupDirectory,
  ) {}

  /**
   * Builds the wire of payments.
   *
   * @param db the database or a transaction
   * @param rows the payments with their accounts and wallet kinds
   * @param contact what the caller may see of a store-balance account's address (decision 047, rule A)
   * @returns the console's payments, in the order of `rows`
   */
  async build(db: DbExecutor, rows: readonly PaymentRow[], contact: CustomerContact): Promise<WirePayment[]> {
    if (rows.length === 0) return [];
    const accountIds = rows.flatMap((row) => (row.accountId === null ? [] : [row.accountId]));
    const pendingIds = rows.flatMap((row) =>
      row.accountId !== null && row.payment.status === 'pending' ? [row.accountId] : [],
    );
    const reviewers = rows.flatMap((row) =>
      row.payment.reviewedBy === null ? [] : [{ type: 'staff' as const, id: row.payment.reviewedBy }],
    );
    const [accounts, wallets, gateways, names, approved] = await Promise.all([
      loadBillingMerchants(db, accountIds),
      this.wallets.viewsOf(db, accountIds),
      findGatewaysByIds(
        db,
        rows.map((row) => row.payment.gatewayId),
      ),
      loadActorNames(db, reviewers),
      accountsWithApprovedTopup(db, pendingIds),
    ]);
    const groups = await this.groups.refsOf(
      db,
      [...accounts.values()].map((account) => account.groupId),
    );
    // The newest chargeback of each top-up, in one query for the page.
    const disputes = await newestDisputesOf(
      db,
      rows.map((row) => row.payment.id),
    );
    return rows.map(({ payment, accountId, walletKind }) => {
      const owner = topUpOwnerWord(walletKind);
      const account = accountId === null ? undefined : accounts.get(accountId);
      const view = accountId === null ? undefined : wallets.get(accountId);
      const gateway = payment.gatewayId === null ? undefined : gateways.get(payment.gatewayId);
      const merchantSide = owner === 'merchant';
      return paymentToWire(payment, {
        clientId: merchantSide ? accountId : null,
        client: merchantSide ? account : undefined,
        groupName: merchantSide && account ? (groups.get(account.groupId)?.name ?? null) : null,
        walletBalance: merchantSide ? balanceOf(view, 'merchant') : null,
        gateway: gateway ? { id: gateway.id, name: gateway.name } : undefined,
        reviewerName: payment.reviewedBy === null ? undefined : names.get(ownerKey('staff', payment.reviewedBy)),
        firstDeposit: accountId !== null && !approved.has(accountId),
        dispute: disputes.get(payment.id),
        customer:
          owner === 'customer' && accountId !== null
            ? {
                id: accountId,
                name: account?.name ?? '',
                email: customerEmailIn(contact, account?.email ?? ''),
                walletBalance: balanceOf(view, 'store'),
              }
            : undefined,
      });
    });
  }
}
