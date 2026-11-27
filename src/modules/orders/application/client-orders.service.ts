// ClientOrdersService: the merchant portal's order use cases (map domain D, stage 5): place an order (or a bulk of IMEIs), cancel an
// order that was never sent, and ask for a verification. Reads are OrderReadService. Every call acts for the signed-in account only, on its
// orders of the merchant doors (a merchant is an account of a merchant rank, decision 064).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import type { JsonObject } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { MERCHANT_CANCEL_REASON } from '../domain/order-timeline';
import { findOrderRow } from '../infra/order-read.repository';
import { IdempotencyStore } from './idempotency-store';
import { canCancel, canVerify, type MerchantOrderView, toMerchantOrder, withActionFacts } from './order-views';
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
 * goes back to the wallet) and asks once for the verification of a completed order inside the service's window. An account acts on
 * its own orders of the merchant doors only: another account's id, and the account's own store order (paid first, in the shop), are `404`,
 * never `403`.
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
    private readonly idempotency: IdempotencyStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Places one order, or one order per IMEI of a bulk, once per `Idempotency-Key` when one is sent.
   *
   * Why: a double click on "Place order" must not place or hold twice (feature 24B, the store scope `portal`).
   * The orders are read back inside the placement's transaction so the answer can be stored with them; the placement itself is the
   * same call as without a key (the key is not written to `orders.idempotency_key`: a bulk makes several orders, and the
   * `idempotency_keys` row alone guards the portal).
   *
   * @param accountId the signed-in account (a merchant rank)
   * @param input the service, the IMEI or IMEIs, the quantity and the custom fields
   * @param source where the order comes from (`portal`)
   * @param key the `Idempotency-Key`, when the merchant sent one
   * @returns the placed orders as the merchant sees them, in the order of the IMEIs, and whether they are the stored answer of an
   *   earlier request with the key (nothing was placed this time)
   * @throws {AppError} see {@link OrderPlacement.place} (a retail rank is `403 RANK_NOT_ALLOWED`); `IDEMPOTENCY_KEY_REUSED`,
   *   `IDEMPOTENCY_IN_PROGRESS`; all items are placed or none is
   */
  async place(
    accountId: number,
    input: PlaceOrderInput,
    source: 'portal' = 'portal',
    key?: string,
  ): Promise<{ orders: MerchantOrderView[]; replayed: boolean }> {
    const inputs = input.inputs ?? {};
    const items =
      input.imeis === undefined
        ? [{ imei: input.imei, inputs, imeiField: 'imei' }]
        : input.imeis.map((imei, index) => ({ imei, inputs, imeiField: `imeis.${index}` }));
    return this.db.runInTransaction(async ({ tx }) => {
      const work = async () => {
        const placed = await this.placement.place(tx, {
          accountId,
          source,
          serviceId: input.serviceId,
          quantity: input.quantity,
          items,
          fileId: input.fileId,
          actor: { type: 'account', id: accountId },
        });
        const now = this.clock.now();
        const rows = await Promise.all(
          placed.map((order) => findOrderRow(tx, { kind: 'merchant', accountId }, order.id)),
        );
        return {
          status: 201,
          body: { orders: rows.map((row) => toMerchantOrder(row!, now)) } as unknown as JsonObject,
        };
      };
      if (key === undefined) {
        const answer = await work();
        return { orders: (answer.body as unknown as { orders: MerchantOrderView[] }).orders, replayed: false };
      }
      const stored = await this.idempotency.run(
        tx,
        { accountId, key, scope: 'portal', requestHash: this.idempotency.hashOf('portal', input) },
        work,
      );
      // An answer stored before decision 075 lacks the four action facts: fill them in, or the response contract refuses the replay.
      const orders = (stored.body as unknown as { orders: MerchantOrderView[] }).orders.map(withActionFacts);
      return { orders, replayed: stored.replayed };
    });
  }

  /**
   * Cancels an order that was never sent to a supplier (not even once).
   *
   * @param accountId the signed-in account (a merchant rank)
   * @param orderId the order
   * @throws {AppError} `NOT_FOUND` (unknown, another account's, or the account's own store order), `ORDER_NOT_OPEN`, `ALREADY_SENT` (the supplier has the order, its send
   *   is in flight, or the order was claimed for a supplier call once: it has a `dispatch` event; decision 044), `INVALID_TRANSITION` (the service does not allow cancellation, or the order is already being
   *   worked on)
   */
  async cancel(accountId: number, orderId: number): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const row = await findOrderRow(tx, { kind: 'merchant', accountId }, orderId);
      if (!row) throw new AppError('NOT_FOUND', { detail: 'No order with this id.' });
      // The machine's own refusals (closed, already sent) answer first; the service's switch only judges what the machine allows.
      if (!row.allowCancel && canCancelByState(row)) {
        throw new AppError('INVALID_TRANSITION', { detail: 'This service does not allow cancellation.' });
      }
      await this.transitions.apply(tx, {
        orderId,
        onlyClientId: accountId,
        action: { kind: 'cancel' },
        actor: { type: 'account', id: accountId },
        reason: MERCHANT_CANCEL_REASON,
      });
    });
  }

  /**
   * Asks for the verification of a completed order.
   *
   * @param accountId the signed-in account (a merchant rank)
   * @param orderId the order
   * @throws {AppError} `NOT_FOUND`, `ORDER_NOT_COMPLETED`, `INVALID_TRANSITION` (already asked, the service does not allow it, or
   *   the verification window has passed)
   */
  async verify(accountId: number, orderId: number): Promise<void> {
    const now = this.clock.now();
    await this.db.runInTransaction(async ({ tx }) => {
      const row = await findOrderRow(tx, { kind: 'merchant', accountId }, orderId);
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
        onlyClientId: accountId,
        action: { kind: 'requestVerification' },
        actor: { type: 'account', id: accountId },
      });
    });
  }
}

/** True while the order could be cancelled by state alone (open and never sent), whatever the service allows. */
function canCancelByState(row: Parameters<typeof canCancel>[0]): boolean {
  return canCancel({ ...row, allowCancel: true });
}
