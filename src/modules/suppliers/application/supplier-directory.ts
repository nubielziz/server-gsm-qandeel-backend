// SupplierDirectory: the suppliers module's public read of supplier names, for the modules that show or label a supplier (ledger owner
// names, the system health view). The only way other modules reach the `suppliers` table without a foreign read of their own.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../infra/db';
import { findSuppliers } from '../infra/supplier.repository';

/** A supplier as other modules need it: its id and name. */
export interface SupplierRef {
  readonly id: number;
  readonly name: string;
}

/**
 * Reads supplier names for other modules.
 *
 * Why: decision 016: a module never reads another module's tables; money's ledger screens and the orders read model name suppliers
 * today with plain foreign reads (documented deviations) and can switch to this service.
 *
 * Side effects: reads only.
 */
@Injectable()
export class SupplierDirectory {
  /**
   * Looks up supplier names.
   *
   * @param db the database or a transaction
   * @param ids the supplier ids
   * @returns the suppliers found, by id (an unknown id has no entry)
   */
  async refs(db: DbExecutor, ids: readonly number[]): Promise<Map<number, SupplierRef>> {
    const found = await findSuppliers(db, ids);
    return new Map([...found].map(([id, supplier]) => [id, { id, name: supplier.name }]));
  }
}
