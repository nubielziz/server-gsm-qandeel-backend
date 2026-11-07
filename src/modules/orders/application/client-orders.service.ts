// ClientOrdersService: the merchant portal's order use cases (map domain D, stage 5): place an order (or a bulk of IMEIs), cancel an
// order that was never sent, and ask for a verification. Reads are OrderReadService. Every call acts for the signed-in merchant only.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { MERCHANT_CANCEL_REASON } from '../domain/order-timeline';
import { findOrderRow } from '../infra/order-read.repository';
import { canCancel, canVerify, type MerchantOrderView, toMerchantOrder } from './order-views';
import { OrderPlacement } from './order-placement';
import { OrderTransitions } from './order-transitions';

/** The body of `POST /client/orders` as the use case reads it. */
export interface PlaceOrderInput {
  readonly serviceId: number;
  readonly imei?: string | undefined;
  readonly imeis?: readonly string[] | undefined;
  readonly quantity?: number | undefined;
  readonly inputs?: Readonly<Record<string, string>> | undefined;
  readonly fileId?: number | undefined;
}

/**
 * Runs the merchant's order actions.
 *
 * Why: scenario manual step 3 and decision 025: the merchant orders through the shared placement path (price, price guard,
 * duplicate rule, hold, dispatch row), cancels an order that was never sent when its service allows it (posts `reject`: the hold
 * goes back to the wallet) and asks once for the verification of a completed order inside the service's window. A merchant acts on
 * its own orders only: another merchant's id is `404`, never `403`.
 *
 * Side effects: each call is one transaction on `orders`, `order_events`, the ledger, `outbox_events`. No audit row: merchant routes
 * write none (B121).
 */
@Injectable()
export class ClientOrdersService {
  constructor(
    private readonly db: DbService,
    private readonly placement: OrderPlacement,
    private readonly transitions: OrderTransitions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Places one order, or one order per IMEI of a bulk.
   *
   * @param clientId the signed-in merchant
   * @param input the service, the IMEI or IMEIs, the quantity and the custom fields
   * @param source where the order comes from (`portal`)
   * @returns the placed orders as the merchant sees them, in the order of the IMEIs
   * @throws {AppError} see {@link OrderPlacement.place}; all items are placed or none is
   */
  async place(clientId: number, input: PlaceOrderInput, source: 'portal' = 'portal'): Promise<MerchantOrderView[]> {
    const inputs = input.inputs ?? {};
    const items =
      input.imeis === undefined
        ? [{ imei: input.imei, inputs, imeiField: 'imei' }]
        : input.imeis.map((imei, index) => ({ imei, inputs, imeiField: `imeis.${index}` }));
    const placed = await this.db.runInTransaction(({ tx }) =>
      this.placement.place(tx, {
        clientId,
        source,
        serviceId: input.serviceId,
        quantity: input.quantity,
        items,
        fileId: input.fileId,
        actor: { type: 'client', id: clientId },
      }),
    );
    const now = this.clock.now();
    const rows = await Promise.all(
      placed.map((order) => findOrderRow(this.db.db, { kind: 'merchant', clientId }, order.id)),
    );
    return rows.map((row) => toMerchantOrder(row!, now));
  }

  /**
   * Cancels an order that was never sent.
   *
   * @param clientId the signed-in merchant
   * @param orderId the order
   * @throws {AppError} `NOT_FOUND` (unknown or another merchant's), `ORDER_NOT_OPEN`, `ALREADY_SENT`, `INVALID_TRANSITION` (the
   *   service does not allow cancellation, or the order is already being worked on)
   */
  async cancel(clientId: number, orderId: number): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const row = await findOrderRow(tx, { kind: 'merchant', clientId }, orderId);
      if (!row) throw new AppError('NOT_FOUND', { detail: 'No order with this id.' });
      // The machine's own refusals (closed, already sent) answer first; the service's switch only judges what the machine allows.
      if (!row.allowCancel && canCancelByState(row)) {
        throw new AppError('INVALID_TRANSITION', { detail: 'This service does not allow cancellation.' });
      }
      await this.transitions.apply(tx, {
        orderId,
        onlyClientId: clientId,
        action: { kind: 'cancel' },
        actor: { type: 'client', id: clientId },
        reason: MERCHANT_CANCEL_REASON,
      });
    });
  }

  /**
   * Asks for the verification of a completed order.
   *
   * @param clientId the signed-in merchant
   * @param orderId the order
   * @throws {AppError} `NOT_FOUND`, `ORDER_NOT_COMPLETED`, `INVALID_TRANSITION` (already asked, the service does not allow it, or
   *   the verification window has passed)
   */
  async verify(clientId: number, orderId: number): Promise<void> {
    const now = this.clock.now();
    await this.db.runInTransaction(async ({ tx }) => {
      const row = await findOrderRow(tx, { kind: 'merchant', clientId }, orderId);
      if (!row) throw new AppError('NOT_FOUND', { detail: 'No order with this id.' });
      if (row.order.status === 'completed' && row.order.verificationStatus === null && !canVerify(row, now)) {
        throw new AppError('INVALID_TRANSITION', {
          detail: row.allowVerify
            ? 'The verification window of this service has passed.'
            : 'This service does not allow verification.',
        });
      }
      await this.transitions.apply(tx, {
        orderId,
        onlyClientId: clientId,
        action: { kind: 'requestVerification' },
        actor: { type: 'client', id: clientId },
      });
    });
  }
}

/** True while the order could be cancelled by state alone (open and never sent), whatever the service allows. */
function canCancelByState(row: Parameters<typeof canCancel>[0]): boolean {
  return canCancel({ ...row, allowCancel: true });
}
