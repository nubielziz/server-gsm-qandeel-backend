// PaymentGateways: what other modules may do with payment gateways (a deleted merchant group leaves the gateways). A leaf file on
// purpose: catalog's group delete injects it, so it must not import catalog (decision 032, import cycles).
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { type DroppedGroup, dropGroupFromGateways } from '../infra/gateway.repository';

/**
 * What other modules may do with payment gateways.
 *
 * Why: catalog-5: deleting a merchant group must also take its id out of `payment_gateways.allowed_group_ids`; the catalog's group
 * delete calls this in its own transaction, because it must not touch this module's table.
 *
 * Side effects: `dropGroup` updates `payment_gateways.allowed_group_ids` and may set `is_active` to false.
 */
@Injectable()
export class PaymentGateways {
  /**
   * Removes a group from every gateway that listed it; a gateway only that group could use is turned off (fail closed).
   *
   * @param tx the transaction of the group delete
   * @param groupId the deleted group
   * @returns how many gateways changed and the ids of those turned off
   */
  dropGroup(tx: DbExecutor, groupId: number): Promise<DroppedGroup> {
    return dropGroupFromGateways(tx, groupId);
  }
}
