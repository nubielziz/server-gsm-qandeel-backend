// Unit tests of the sync counts.
import { describe, expect, it } from 'bun:test';
import type { RemoteService } from './dhru-protocol';
import { syncCounts } from './sync-plan';

const remote = (remoteId: string, credit: string): RemoteService => ({
  remoteId,
  group: 'G',
  type: 'IMEI',
  name: `Service ${remoteId}`,
  credit,
  time: '',
  requires: {},
  customFields: [],
  raw: {},
});

describe('syncCounts', () => {
  it('counts the added, the changed (price or back again) and the removed services, and what is listed', () => {
    const counts = syncCounts(
      [
        { remoteId: '1', credit: '5.0000', isAvailable: true },
        { remoteId: '2', credit: '6.0000', isAvailable: true },
        { remoteId: '3', credit: '7.0000', isAvailable: false },
        { remoteId: '4', credit: '8.0000', isAvailable: true },
        { remoteId: '5', credit: '9.0000', isAvailable: false },
      ],
      [remote('1', '5.0000'), remote('2', '6.5000'), remote('3', '7.0000'), remote('6', '1.0000')],
    );
    expect(counts).toEqual({ services: 4, added: 1, changed: 2, removed: 1 });
  });

  it('is all zero for an empty list and an empty store', () => {
    expect(syncCounts([], [])).toEqual({ services: 0, added: 0, changed: 0, removed: 0 });
  });
});
