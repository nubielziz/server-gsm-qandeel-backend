// Unit tests of the suggest use case's popular-phrases cache handling (feature 29, plan section 5.2): a fallback's peek and the empty
// box's real load share one in-flight load per key in the cache, and the real load must never fail because of the peek.
import { describe, expect, it } from 'bun:test';
import type { CacheService } from '@src/infra/cache';
import { SuggestService } from '@src/modules/storefront/search/application/suggest.service';

/** A cache that shares one in-flight load per key, as the real `CacheService.getOrLoad` does, and never stores a value. */
function sharingCache(): CacheService {
  const loading = new Map<string, Promise<unknown>>();
  return {
    getOrLoad<T>(key: string, _ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
      const shared = loading.get(key);
      if (shared) return shared as Promise<T>;
      // The loader runs a tick later, so a second caller in the same tick joins this flight.
      const flight = Promise.resolve()
        .then(loader)
        .finally(() => loading.delete(key));
      loading.set(key, flight);
      return flight;
    },
  } as unknown as CacheService;
}

interface Inner {
  cachedPopular(): Promise<string[]>;
  loadPopular: () => Promise<string[]>;
}

function service(loaded: string[][]): { suggest: SuggestService; inner: Inner; loads: () => number } {
  const none = {} as never;
  const keys = { searchPopular: () => 'gsm:test:storefront:search-popular' } as never;
  const suggest = new SuggestService(none, none, none, none, sharingCache(), keys, none, none, none, none, none, none);
  const inner = suggest as unknown as Inner;
  let calls = 0;
  inner.loadPopular = () => Promise.resolve(loaded[calls++] ?? []);
  return { suggest, inner, loads: () => calls };
}

describe('SuggestService.popular', () => {
  it('loads for real when it joined the in-flight peek of a fallback, instead of failing with its rejection', async () => {
    const { suggest, inner, loads } = service([['samsung frp']]);
    const peek = inner.cachedPopular();
    const popular = suggest.popular();
    expect(await popular).toEqual(['samsung frp']);
    expect(await peek).toEqual([]);
    expect(loads()).toBe(1);
  });

  it('answers the cached phrases to a peek when nothing is cached, without loading', async () => {
    const { inner, loads } = service([['never read']]);
    expect(await inner.cachedPopular()).toEqual([]);
    expect(loads()).toBe(0);
  });

  it('still throws a real failure of the load', async () => {
    const { suggest, inner } = service([]);
    inner.loadPopular = () => Promise.reject(new Error('postgres is down'));
    const failure = await suggest.popular().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('postgres is down');
  });
});
