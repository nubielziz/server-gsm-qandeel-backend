// OrderReceiptService: the receipt download of a storefront order (feature 16, map `GET /store/v1/orders/:token/receipt`). A thin seam between
// the tracking route and the money module's receipt renderer.
import { Injectable } from '@nestjs/common';
import { DbService } from '../../../infra/db';
import { OrderReceipts } from '../../money';

/**
 * Serves the receipt of an order.
 *
 * Why: the tax receipt is an invoice of the money module (RESOLUTIONS money-7); the tracking token resolves to an order id here and the
 * money module serves the PDF it stored when the payment was captured.
 *
 * Side effects: none on the normal path; a receipt whose stored copy is missing is made and stored by the first download (`OrderReceipts`).
 */
@Injectable()
export class OrderReceiptService {
  constructor(
    private readonly db: DbService,
    private readonly receipts: OrderReceipts,
  ) {}

  /**
   * Reads the receipt of an order.
   *
   * @param orderId the order the tracking token resolved to
   * @returns the PDF bytes and the download name
   * @throws {AppError} `NOT_FOUND` when the order has no receipt
   */
  receipt(orderId: number): Promise<{ bytes: Uint8Array; filename: string }> {
    return this.receipts.read(this.db.db, orderId);
  }
}
