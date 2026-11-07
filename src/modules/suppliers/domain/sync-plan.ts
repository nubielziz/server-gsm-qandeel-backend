// Counting what a sync changed (`POST /admin/suppliers/:id/sync` answers `{ services, added, changed, removed }`). Pure.
import type { RemoteService } from './dhru-protocol';

/** A synced row as stored before the sync. */
export interface StoredSupplierService {
  readonly remoteId: string;
  /** The price in supplier credits, 4 decimals. */
  readonly credit: string;
  readonly isAvailable: boolean;
}

/** What a sync found. */
export interface SyncCounts {
  /** Services the supplier lists now. */
  readonly services: number;
  /** Listed now and never stored before. */
  readonly added: number;
  /** Stored before, and now at another price or listed again after being gone. */
  readonly changed: number;
  /** Stored as available, not listed now. */
  readonly removed: number;
}

/**
 * Compares a supplier's list with the rows stored for it.
 *
 * Why: the sync's answer and `price_changed_at`: a credit change counts as `changed` (and sets the mark), a service the supplier no
 * longer lists is `removed` (`is_available` false), one that comes back counts as `changed`.
 *
 * @param stored the supplier's rows before the sync
 * @param incoming the supplier's list now
 * @returns the four counts
 */
export function syncCounts(stored: readonly StoredSupplierService[], incoming: readonly RemoteService[]): SyncCounts {
  const before = new Map(stored.map((row) => [row.remoteId, row]));
  const listed = new Set<string>();
  let added = 0;
  let changed = 0;
  for (const item of incoming) {
    listed.add(item.remoteId);
    const row = before.get(item.remoteId);
    if (!row) added += 1;
    else if (row.credit !== item.credit || !row.isAvailable) changed += 1;
  }
  const removed = stored.filter((row) => row.isAvailable && !listed.has(row.remoteId)).length;
  return { services: incoming.length, added, changed, removed };
}
