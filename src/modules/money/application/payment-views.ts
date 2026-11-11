// PaymentViews: builds the wire of a page of top-up payments: one query per kind of thing around them (merchants, groups, wallets,
// gateways, reviewers), never one per row.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { ClientGroupDirectory } from '../../catalog';
import { readCustomerBalances } from '../infra/customer-wallet.repository';
import { newestDisputesOf } from '../infra/dispute.repository';
import {
  loadActorNames,
  loadBillingMerchants,
  loadWalletCustomers,
  ownerKey,
} from '../infra/foreign-directory.repository';
import { findGatewaysByIds } from '../infra/gateway.repository';
import { type PaymentRow, clientsWithApprovedTopup, customersWithApprovedTopup } from '../infra/payment.repository';
import { type WirePayment, paymentToWire } from './billing-wire';
import { MerchantWallets } from './merchant-wallets';

/**
 * Turns payment rows into the console's `Payment`.
 *
 * Why: the Deposits tab shows the merchant (or, feature 21, the storefront customer), its group and current wallet balance, the gateway
 * and the reviewer next to each
 * payment, and the newest chargeback of the top-up (money.md `GET /admin/payments`), so a page needs five reads around the rows; they are batched here and shared by the list,
 * the single read and the answers of approve and reject. The wallet balance is read from the ledger accounts each time (never
 * cached: money, decision 022).
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class PaymentViews {
  constructor(
    private readonly wallets: MerchantWallets,
    private readonly groups: ClientGroupDirectory,
  ) {}

  /**
   * Builds the wire of payments.
   *
   * @param db the database or a transaction
   * @param rows the payments with their merchants
   * @returns the console's payments, in the order of `rows`
   */
  async build(db: DbExecutor, rows: readonly PaymentRow[]): Promise<WirePayment[]> {
    if (rows.length === 0) return [];
    const clientIds = rows.flatMap((row) => (row.clientId === null ? [] : [row.clientId]));
    const pendingClientIds = rows.flatMap((row) =>
      row.clientId !== null && row.payment.status === 'pending' ? [row.clientId] : [],
    );
    const reviewers = rows.flatMap((row) =>
      row.payment.reviewedBy === null ? [] : [{ type: 'staff' as const, id: row.payment.reviewedBy }],
    );
    const [merchants, wallets, gateways, names, approved] = await Promise.all([
      loadBillingMerchants(db, clientIds),
      this.wallets.viewsOf(db, clientIds),
      findGatewaysByIds(
        db,
        rows.map((row) => row.payment.gatewayId),
      ),
      loadActorNames(db, reviewers),
      clientsWithApprovedTopup(db, pendingClientIds),
    ]);
    const groups = await this.groups.refsOf(
      db,
      [...merchants.values()].map((merchant) => merchant.groupId),
    );
    // Feature 21: store balance top-ups name their customer with the balance now (never cached).
    const customerIds = rows.flatMap((row) => (row.customerId === null ? [] : [row.customerId]));
    const customers = await loadWalletCustomers(db, customerIds);
    const balances = await readCustomerBalances(db, customerIds);
    const customersApproved = await customersWithApprovedTopup(
      db,
      rows.flatMap((row) => (row.customerId !== null && row.payment.status === 'pending' ? [row.customerId] : [])),
    );
    // Feature 21: the newest chargeback of each top-up (customers and merchants), in one query for the page.
    const disputes = await newestDisputesOf(
      db,
      rows.map((row) => row.payment.id),
    );
    return rows.map(({ payment, clientId, customerId }) => {
      const customer = customerId === null ? undefined : customers.get(customerId);
      const merchant = clientId === null ? undefined : merchants.get(clientId);
      const gateway = payment.gatewayId === null ? undefined : gateways.get(payment.gatewayId);
      return paymentToWire(payment, {
        clientId,
        client: merchant,
        groupName: merchant ? (groups.get(merchant.groupId)?.name ?? null) : null,
        walletBalance: clientId === null ? null : (wallets.get(clientId)?.balance ?? null),
        gateway: gateway ? { id: gateway.id, name: gateway.name } : undefined,
        reviewerName: payment.reviewedBy === null ? undefined : names.get(ownerKey('staff', payment.reviewedBy)),
        firstDeposit:
          (clientId !== null && !approved.has(clientId)) || (customerId !== null && !customersApproved.has(customerId)),
        dispute: disputes.get(payment.id),
        customer:
          customerId === null
            ? undefined
            : {
                id: customerId,
                name: customer?.name ?? '',
                email: customer?.email ?? '',
                walletBalance: balances.get(customerId) ?? null,
              },
      });
    });
  }
}
