// RolePermissions: the permissions of a role, cached per role (decision 018: "checked on every request from the role's
// current permissions (no snapshot per session)"). The role routes of feature 2a invalidate it after every change.
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { CacheKeys, CacheService } from '../../../infra/cache';
import { DbService, type TransactionContext } from '../../../infra/db';
import { roles } from '../db/schema';

/** How long a role's permissions stay in the cache; role changes invalidate sooner. */
export const ROLE_CACHE_TTL_SECONDS = 300;

/**
 * Reads the permissions of roles through the cache.
 *
 * Why: every staff request needs the caller's permissions, and a role has the same permissions for every member. A cache
 * entry per role keeps the check off Postgres, and deleting that entry after a role change makes the change apply on the
 * next request ("Permission and role changes apply on the next request", ALIGNMENT § 3).
 *
 * Side effects: reads `roles` on a miss; reads and deletes `gsm:{env}:identity:role:{roleId}` in the cache Redis.
 *
 * @see docs/cache-keys.md
 */
@Injectable()
export class RolePermissions {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
  ) {}

  /**
   * Returns the permissions of a role as stored (`*`, `area:*`, `area:action`).
   *
   * @param roleId the role id
   * @returns the list, empty for a role that no longer exists (a deleted role grants nothing)
   */
  permissionsOf(roleId: number): Promise<readonly string[]> {
    return this.cache.getOrLoad(this.keys.rolePermissions(roleId), ROLE_CACHE_TTL_SECONDS, async () => {
      const [row] = await this.db.db
        .select({ permissions: roles.permissions })
        .from(roles)
        .where(eq(roles.id, roleId))
        .limit(1);
      return row?.permissions ?? [];
    });
  }

  /**
   * Forgets a role's cached permissions.
   *
   * Why: decision 022 invalidates after the commit. Call it from the role update and delete use cases (and when a role is
   * created with an id that may have been cached as missing).
   *
   * Side effects: deletes `gsm:{env}:identity:role:{roleId}` (after the commit when `work` is given).
   *
   * @param roleId the role id
   * @param work the caller's transaction context, if it has one
   * @throws {Error} when Redis fails and no `work` is given
   */
  async invalidate(roleId: number, work?: Pick<TransactionContext, 'afterCommit'>): Promise<void> {
    const forget = async (): Promise<void> => {
      await this.cache.del(this.keys.rolePermissions(roleId));
    };
    if (work) work.afterCommit(forget);
    else await forget();
  }
}
