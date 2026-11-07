// InventoryStock: hands codes from the code inventory to an order at placement (RULES orders 10). The orders module calls it
// inside the placement transaction, so the codes leave the stock only if the order commits.
import { Injectable } from '@nestjs/common';
import { EncryptionService } from '../../../infra/crypto';
import type { DbExecutor } from '../../../infra/db';
import { INVENTORY_CODE_AAD } from '../domain/inventory-codes';
import { lockAvailableCodes, sellLockedCodes } from '../infra/inventory.repository';

/** Codes locked for one order: sell them once the order row exists. */
export interface StockClaim {
  /** The locked `inventory_codes` ids, oldest first. */
  readonly ids: readonly number[];
  /** The codes in clear, in the same order: the order's result, which the buyer receives. */
  readonly codes: readonly string[];
}

/**
 * Delivers stocked codes to orders.
 *
 * Why: RULES orders 10 and resolution orders-suppliers-11 (placement → done when an inventory code is delivered at once): a
 * service with codes in stock delivers from stock first, whatever its fulfilment mode; with fewer available codes than the order's
 * quantity nothing is taken and the order goes the usual way (a supplier, or the manual queue). A delivered code never returns to
 * stock (a refund or a reopen leaves it sold). Codes are decrypted only to become the order's result.
 *
 * Side effects (on the caller's transaction): `claim` locks `inventory_codes` rows; `sell` marks them sold with the order id.
 */
@Injectable()
export class InventoryStock {
  constructor(private readonly encryption: EncryptionService) {}

  /**
   * Locks the codes an order needs, when the stock has enough.
   *
   * @param tx the placement transaction
   * @param serviceId the service ordered
   * @param quantity how many codes the order needs (its quantity)
   * @returns the claim, or `null` when the service has fewer available codes (nothing is locked then)
   */
  async claim(tx: DbExecutor, serviceId: number, quantity: number): Promise<StockClaim | null> {
    if (quantity < 1) return null;
    const rows = await lockAvailableCodes(tx, serviceId, quantity);
    if (rows.length < quantity) return null;
    return {
      ids: rows.map((row) => row.id),
      codes: rows.map((row) => this.encryption.decrypt(row.codeEnc, INVENTORY_CODE_AAD)),
    };
  }

  /**
   * Marks claimed codes as sold to the order.
   *
   * @param tx the transaction that made the claim
   * @param claim what {@link claim} returned
   * @param orderId the order the codes were delivered to
   * @throws {Error} when a claimed code is no longer available (impossible while this transaction holds the row locks)
   */
  async sell(tx: DbExecutor, claim: StockClaim, orderId: number): Promise<void> {
    const sold = await sellLockedCodes(tx, claim.ids, orderId);
    if (sold !== claim.ids.length) {
      throw new Error(
        `Only ${String(sold)} of the ${String(claim.ids.length)} claimed codes could be sold to order ${String(orderId)}.`,
      );
    }
  }
}
