// Unit test of the keys step's guard (feature 29, plan section 3.3): the bootstrap, indexer and search keys must be three different
// values, every pair compared (an indexer key equal to the bootstrap key would give the worker the node's unscoped admin key).
import { describe, expect, it } from 'bun:test';
import { keysAreDistinct } from '../../scripts/search-keys';

describe('keysAreDistinct', () => {
  it('accepts three different keys', () => {
    expect(keysAreDistinct({ bootstrap: 'boot', indexer: 'index', search: 'find' })).toBe(true);
  });

  it('refuses any two equal keys, whichever pair', () => {
    expect(keysAreDistinct({ bootstrap: 'same', indexer: 'same', search: 'find' })).toBe(false);
    expect(keysAreDistinct({ bootstrap: 'same', indexer: 'index', search: 'same' })).toBe(false);
    expect(keysAreDistinct({ bootstrap: 'boot', indexer: 'same', search: 'same' })).toBe(false);
    expect(keysAreDistinct({ bootstrap: 'same', indexer: 'same', search: 'same' })).toBe(false);
  });
});
