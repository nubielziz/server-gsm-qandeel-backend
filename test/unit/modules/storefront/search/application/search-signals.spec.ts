// Unit tests of the search's change signals (feature 29, plan section 4.5): events of at most 50 ids, ids only, the right aggregates.
import { describe, expect, it } from 'bun:test';
import type { DbExecutor } from '@src/infra/db';
import { CatalogSignals, MAX_IDS_PER_EVENT, idChunks } from '@src/modules/catalog';
import type { OutboxEventInput, OutboxService } from '@src/modules/platform';
import { LISTING_CHANGED_EVENT, SearchSignals } from '@src/modules/storefront/search/application/search-signals';

const tx = {} as DbExecutor;

function recordingOutbox(): { outbox: OutboxService; events: OutboxEventInput[] } {
  const events: OutboxEventInput[] = [];
  const outbox = {
    add: (_tx: DbExecutor, event: OutboxEventInput) => {
      events.push(event);
      return Promise.resolve({} as never);
    },
  } as unknown as OutboxService;
  return { outbox, events };
}

describe('idChunks', () => {
  it('splits distinct ascending ids into chunks of 50', () => {
    const ids = Array.from({ length: 120 }, (_, i) => 120 - i);
    const chunks = idChunks([...ids, 5, 5]);
    expect(chunks.map((chunk) => chunk.length)).toEqual([50, 50, 20]);
    expect(chunks[0]![0]).toBe(1);
    expect(chunks.flat()).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    expect(idChunks([])).toEqual([]);
    expect(MAX_IDS_PER_EVENT).toBe(50);
  });

  it('keeps every event under the outbox payload limit (2048 bytes) with ten-digit ids', () => {
    const [chunk] = idChunks(Array.from({ length: 50 }, (_, i) => 9_999_999_900 + i));
    expect(Buffer.byteLength(JSON.stringify({ serviceIds: chunk, reason: 'service' }))).toBeLessThan(2048);
  });
});

describe('SearchSignals and CatalogSignals', () => {
  it('write a 120-id listing change as 3 events on the services aggregate', async () => {
    const { outbox, events } = recordingOutbox();
    await new SearchSignals(outbox).listingsChanged(
      tx,
      Array.from({ length: 120 }, (_, i) => i + 1),
    );
    expect(events.map((event) => [event.type, event.aggregateType, event.aggregateId])).toEqual([
      [LISTING_CHANGED_EVENT, 'services', 1],
      [LISTING_CHANGED_EVENT, 'services', 51],
      [LISTING_CHANGED_EVENT, 'services', 101],
    ]);
  });

  it('write the catalog events with their reason and the category id', async () => {
    const { outbox, events } = recordingOutbox();
    const signals = new CatalogSignals(outbox);
    await signals.servicesChanged(tx, [7, 3], 'price');
    await signals.categoryChanged(tx, 9);
    await signals.servicesChanged(tx, [], 'stock');
    expect(events).toEqual([
      {
        type: 'catalog.services_changed',
        aggregateType: 'services',
        aggregateId: 3,
        payload: { serviceIds: [3, 7], reason: 'price' },
      },
      {
        type: 'catalog.category_changed',
        aggregateType: 'service_categories',
        aggregateId: 9,
        payload: { categoryId: 9 },
      },
    ]);
  });

  it('write the settings and rebuild events on their aggregates', async () => {
    const { outbox, events } = recordingOutbox();
    const signals = new SearchSignals(outbox);
    await signals.settingsChanged(tx, 'pins', 4);
    await signals.rebuildRequested(tx, 2, 31);
    expect(events).toEqual([
      { type: 'search.settings_changed', aggregateType: 'search_pins', aggregateId: 4, payload: { kind: 'pins' } },
      {
        type: 'search.rebuild_requested',
        aggregateType: 'search_index',
        aggregateId: 1,
        payload: { staffId: 2, runId: 31 },
      },
    ]);
  });
});
