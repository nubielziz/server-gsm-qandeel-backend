// CatalogPriceVersion: the catalog's price version (decision 022, user rule 9 (c)). A counter on the cache Redis that moves
// whenever a resolved price can change; every cached price list reads through a key that carries it, so one bump empties them all.
import { Injectable, Logger } from '@nestjs/common';
import { type CacheKey, CacheService } from '../../../infra/cache';

/** The name of the version counter: the key is `gsm:{env}:cache:version:catalog`. */
export const CATALOG_VERSION_NAME = 'catalog';

/** The part of a transaction context the version needs: where to register the bump. */
export interface AfterCommitHook {
  afterCommit(callback: () => void | Promise<void>): void;
}

/**
 * Moves and reads the catalog price version.
 *
 * Why: user rule 9 (c) and MISMATCHES B117 (3): price lists (Dhru, REST v1, the merchant catalog) may be cached, and they must
 * never show a price older than a change of a price, a pricing rule, a merchant group's discount, a category or a service's
 * effective cost. Every writer of those calls `bumpAfterCommit` in its use case; the supplier sync of feature 6 does the same
 * when `recomputeEffectiveCost` reports a change. A price list is never the truth for a charge (the order path resolves
 * again in its transaction), so a missed bump (Redis down) costs at most the cache TTL of staleness.
 *
 * Side effects: writes `gsm:{env}:cache:version:catalog` (docs/cache-keys.md).
 */
@Injectable()
export class CatalogPriceVersion {
  private readonly logger = new Logger(CatalogPriceVersion.name);

  constructor(private readonly cache: CacheService) {}

  /**
   * Registers the bump to run once the transaction has committed.
   *
   * @param work the transaction context of the use case (`afterCommit` is all it needs)
   */
  bumpAfterCommit(work: AfterCommitHook): void {
    work.afterCommit(async () => {
      await this.bump();
    });
  }

  /**
   * Moves the version now (call it after the commit, never before: a rolled-back change must not empty the cache).
   *
   * @returns the new version number, or `undefined` when Redis could not be reached (logged; lists then age out by TTL)
   */
  async bump(): Promise<number | undefined> {
    try {
      return await this.cache.bumpVersion(CATALOG_VERSION_NAME);
    } catch (error) {
      this.logger.error(
        `Could not move the catalog price version: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Appends the current version to a key: the key of a cached price list.
   *
   * @param key the base key of the list (built by `CacheKeys`)
   * @returns `{key}:v{n}`; when Redis cannot be read, a one-time key that matches nothing (a miss, never an old list)
   */
  versioned(key: CacheKey): Promise<CacheKey> {
    return this.cache.versioned(CATALOG_VERSION_NAME, key);
  }
}
