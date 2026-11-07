// ClientGroupDirectory: the read-only door to `client_groups` for other modules (identity reads a merchant's group), because a
// module never queries another module's tables (decision 016, resolution identity-platform-3). Feature 4a extends it.
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { type ClientGroup, clientGroups } from '../db/schema';

/** A merchant group as other modules see it: what a sign-in answer or a new merchant needs, nothing about promotion rules. */
export interface ClientGroupView {
  readonly id: number;
  readonly name: string;
  /** `b2b` for merchant groups; `b2c_retail` marks the storefront's retail group, which no merchant belongs to. */
  readonly kind: string;
  /** The percentage off list prices, an exact decimal as stored (for example `5.0000`). */
  readonly discountPercent: string;
  readonly isDefault: boolean;
  /** Whether a merchant of this group may have a credit limit (user rule 2). */
  readonly overdraftAllowed: boolean;
}

function viewOf(row: ClientGroup): ClientGroupView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    discountPercent: row.discountPercent,
    isDefault: row.isDefault,
    overdraftAllowed: row.overdraftAllowed,
  };
}

/**
 * Reads merchant groups for other modules.
 *
 * Why: `POST /client/auth/register` puts a new merchant in the `is_default` group and `GET /client/auth/me` shows the group's
 * name and discount; the catalog module owns `client_groups`, so it answers instead of identity joining the table.
 *
 * Side effects: none (reads only).
 */
@Injectable()
export class ClientGroupDirectory {
  /**
   * Finds a group by id.
   *
   * @param db the database or a transaction
   * @param id the group id
   * @returns the group, or `undefined` when it does not exist
   */
  async find(db: DbExecutor, id: number): Promise<ClientGroupView | undefined> {
    const [row] = await db.select().from(clientGroups).where(eq(clientGroups.id, id)).limit(1);
    return row ? viewOf(row) : undefined;
  }

  /**
   * Finds the group new merchants join.
   *
   * @param db the database or a transaction
   * @returns the `is_default` group (a unique partial index allows one), or `undefined` when none is set
   */
  async defaultGroup(db: DbExecutor): Promise<ClientGroupView | undefined> {
    const [row] = await db.select().from(clientGroups).where(eq(clientGroups.isDefault, true)).limit(1);
    return row ? viewOf(row) : undefined;
  }
}
