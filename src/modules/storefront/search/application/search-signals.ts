// SearchSignals: the outbox events of the storefront that the search index follows (feature 29, decision 038): a listing changed, the
// search settings changed, a rebuild was asked for. Ids only, in the writer's transaction.
import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '../../../../infra/db';
import { idChunks } from '../../../catalog';
import { OutboxService } from '../../../platform';

/** The outbox event of listings that changed (`{ serviceIds }`, 1-50 ids, aggregate `services`). */
export const LISTING_CHANGED_EVENT = 'storefront.listing_changed';
/** The outbox event of a change of synonyms, pins or hidden terms (`{ kind }`). */
export const SETTINGS_CHANGED_EVENT = 'search.settings_changed';
/** The outbox event of the console's "Rebuild index" (`{ staffId }`, aggregate `search_index`, 1). */
export const REBUILD_REQUESTED_EVENT = 'search.rebuild_requested';

/**
 * The job names of the search (queues `search-index` and `maintenance`).
 *
 * Why: the processors, the outbox routes, the schedulers, the follow-up jobs and `docs/queues.md` must agree on them; they are also the
 * names the console's jobs list shows.
 */
export const SEARCH_JOBS = {
  sync: 'search_sync',
  settings: 'search_settings',
  reconcile: 'search_reconcile',
  rebuild: 'search_rebuild',
  termsBuild: 'search_terms_build',
  termsFlush: 'search_terms_flush',
  termsPurge: 'search_terms_purge',
} as const;

/**
 * What a settings change touched.
 *
 * Why: plan section 4.5: the `search_settings` job pushes the whole set of the kind (synonyms, pins) or, for hidden terms, rebuilds
 * the terms collection.
 */
export const SEARCH_SETTINGS_KINDS = ['synonyms', 'pins', 'hidden_terms'] as const;

/** One value of {@link SEARCH_SETTINGS_KINDS}. */
export type SearchSettingsKind = (typeof SEARCH_SETTINGS_KINDS)[number];

const SETTINGS_AGGREGATE: Readonly<Record<SearchSettingsKind, string>> = {
  synonyms: 'search_synonyms',
  pins: 'search_pins',
  hidden_terms: 'search_hidden_terms',
};

/**
 * Writes the storefront's events for the search index.
 *
 * Why: decision 038 ("change signals"): a listing writer (create, update of any field, which also covers the retail price of the same
 * PATCH) and the console's search routes write their event in their own transaction; the `search-index` queue applies the listing
 * events, the settings events and (on `maintenance`) the rebuild. A longer id list is split into events of 50.
 *
 * Side effects: inserts `outbox_events` rows on the caller's transaction.
 *
 * @see docs/queues.md (search-index)
 */
@Injectable()
export class SearchSignals {
  constructor(private readonly outbox: OutboxService) {}

  /**
   * Records that the listings of some services changed.
   *
   * @param tx the writer's transaction
   * @param serviceIds the services whose listings changed (split into events of 50)
   */
  async listingsChanged(tx: DbExecutor, serviceIds: readonly number[]): Promise<void> {
    for (const chunk of idChunks(serviceIds)) {
      await this.outbox.add(tx, {
        type: LISTING_CHANGED_EVENT,
        aggregateType: 'services',
        aggregateId: chunk[0]!,
        payload: { serviceIds: chunk },
      });
    }
  }

  /**
   * Records that staff changed synonyms, pins or hidden terms.
   *
   * @param tx the admin write's transaction
   * @param kind what changed
   * @param rowId the row that changed
   */
  async settingsChanged(tx: DbExecutor, kind: SearchSettingsKind, rowId: number): Promise<void> {
    await this.outbox.add(tx, {
      type: SETTINGS_CHANGED_EVENT,
      aggregateType: SETTINGS_AGGREGATE[kind],
      aggregateId: rowId,
      payload: { kind },
    });
  }

  /**
   * Records that staff asked for a rebuild of the index.
   *
   * @param tx the admin write's transaction
   * @param staffId who asked
   * @param runId the `job_runs` row the route started, when it started one (the rebuild records its work on it)
   */
  async rebuildRequested(tx: DbExecutor, staffId: number, runId?: number): Promise<void> {
    await this.outbox.add(tx, {
      type: REBUILD_REQUESTED_EVENT,
      aggregateType: 'search_index',
      aggregateId: 1,
      payload: runId === undefined ? { staffId } : { staffId, runId },
    });
  }
}
