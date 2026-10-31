// Unit tests of SettingsReader (platform module): cached snapshot, whole-number settings with a fallback, invalidation.
import { describe, expect, it } from 'bun:test';
import { parseEnv } from '../../../config';
import { CacheKeys, type CacheService } from '../../../infra/cache';
import type { DbService } from '../../../infra/db';
import { SETTINGS_TTL_SECONDS, SettingsReader } from './settings-reader';

const keys = new CacheKeys(parseEnv({ NODE_ENV: 'test' }));

/** A reader over a fake cache that runs the loader every time and records what it was asked. */
function reader(values: Record<string, unknown>) {
  const asked: Array<{ key: string; ttl: number }> = [];
  const deleted: string[] = [];
  const cache = {
    getOrLoad: (key: string, ttl: number, loader: () => Promise<unknown>) => {
      asked.push({ key, ttl });
      return loader();
    },
    del: (...names: string[]) => {
      deleted.push(...names);
      return Promise.resolve(names.length);
    },
  } as unknown as CacheService;
  // loadAllSettings selects { key, value } rows from the table: a tiny fake of the Drizzle chain.
  const rows = Object.entries(values).map(([key, value]) => ({ key, value }));
  const db = { db: { select: () => ({ from: () => Promise.resolve(rows) }) } } as unknown as DbService;
  return { reader: new SettingsReader(db, cache, keys), asked, deleted };
}

describe('SettingsReader', () => {
  it('reads the whole table as one flat object through the cache, for a minute', async () => {
    const { reader: settings, asked } = reader({ a: 1, b: 'x', c: { d: true } });
    expect(await settings.all()).toEqual({ a: 1, b: 'x', c: { d: true } });
    expect(asked).toEqual([{ key: 'gsm:test:platform:settings:all', ttl: SETTINGS_TTL_SECONDS }]);
    expect(SETTINGS_TTL_SECONDS).toBe(60);
  });

  it('returns one value, undefined when the key was never set', async () => {
    const { reader: settings } = reader({ a: 1 });
    expect(await settings.get('a')).toBe(1);
    expect(await settings.get('missing')).toBeUndefined();
  });

  it('returns a whole number inside the bounds, otherwise the fallback', async () => {
    const bounds = { min: 1, max: 100 };
    const { reader: settings } = reader({ ok: 30, low: 0, high: 101, frac: 1.5, text: '30', flag: true, list: [30] });
    expect(await settings.integer('ok', 7, bounds)).toBe(30);
    for (const key of ['low', 'high', 'frac', 'text', 'flag', 'list', 'absent']) {
      expect(await settings.integer(key, 7, bounds), key).toBe(7);
    }
  });

  it('accepts the bounds themselves', async () => {
    const { reader: settings } = reader({ low: 1, high: 100 });
    expect(await settings.integer('low', 7, { min: 1, max: 100 })).toBe(1);
    expect(await settings.integer('high', 7, { min: 1, max: 100 })).toBe(100);
  });

  it('reads several whole numbers with one read of the snapshot', async () => {
    const { reader: settings, asked } = reader({ a: 5, b: -1 });
    const result = await settings.integers({
      a: { fallback: 1, min: 1, max: 10 },
      b: { fallback: 2, min: 1, max: 10 },
      c: { fallback: 3, min: 1, max: 10 },
    });
    expect(result).toEqual({ a: 5, b: 2, c: 3 });
    expect(asked).toHaveLength(1);
  });

  it('forgets the cached snapshot on invalidate', async () => {
    const { reader: settings, deleted } = reader({});
    await settings.invalidate();
    expect(deleted).toEqual(['gsm:test:platform:settings:all']);
  });
});
