// PaymentViews: builds the wire of a page of top-up payments: one query per kind of thing around them (merchants, groups, wallets,
// gateways, reviewers), never one per row.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { ClientGroupDirectory } from '../../catalog';
import { loadActorNames, loadBillingMerchants, ownerKey } from '../infra/foreign-directory.repository';
import { findGatewaysByIds } from '../infra/gateway.repository';
import { type PaymentRow, clientsWithApprovedTopup } from '../infra/payment.repository';
import { type WirePayment, paymentToWire } from './billing-wire';
import { MerchantWallets } from './merchant-wallets';

/**
 * Turns payment rows into the console's `Payment`.
 *
 * Why: the Deposits tab shows the merchant, its group and current wallet balance, the gateway and the reviewer next to each
 * payment (money.md `GET /admin/payments`), so a page needs five reads around the rows; they are batched here and shared by the list,
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
    return rows.map(({ payment, clientId }) => {
      const merchant = clientId === null ? undefined : merchants.get(clientId);
      const gateway = gateways.get(payment.gatewayId);
      return paymentToWire(payment, {
        clientId,
        client: merchant,
        groupName: merchant ? (groups.get(merchant.groupId)?.name ?? null) : null,
        walletBalance: clientId === null ? null : (wallets.get(clientId)?.balance ?? null),
        gateway: gateway ? { id: gateway.id, name: gateway.name } : undefined,
        reviewerName: payment.reviewedBy === null ? undefined : names.get(ownerKey('staff', payment.reviewedBy)),
        firstDeposit: clientId !== null && !approved.has(clientId),
      });
    });
  }
}
