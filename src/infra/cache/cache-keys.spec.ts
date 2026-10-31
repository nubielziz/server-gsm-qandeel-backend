// Unit tests of the cache key builders (decision 022): the key shape, validation of every part, and the check that every
// builder is described in CACHE_KEY_FAMILIES and listed in docs/cache-keys.md (and nothing is documented that has no builder).
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from '../../config';
import { CACHE_KEY_FAMILIES, CacheKeys, familyOf } from './cache-keys';

const keys = new CacheKeys(parseEnv({ NODE_ENV: 'test' }));
const docs = readFileSync(join(import.meta.dir, '../../../docs/cache-keys.md'), 'utf8');

describe('CacheKeys builders', () => {
  it('build gsm:{env}:{module}:{entity}:{id}', () => {
    expect<string>(keys.version('catalog')).toBe('gsm:test:cache:version:catalog');
    expect<string>(keys.semaphore('supplier-12')).toBe('gsm:test:semaphore:supplier-12');
    expect(keys.rateLimit('sign-in')).toBe('gsm:test:ratelimit:sign-in');
    expect<string>(keys.prefix('catalog', 'service')).toBe('gsm:test:catalog:service:');
    expect<string>(keys.prefix('catalog', 'service', '12')).toBe('gsm:test:catalog:service:12');
    expect<string>(keys.lock(keys.version('catalog'))).toBe('gsm:test:cache:version:catalog:lock');
  });

  it('put the environment in every key', () => {
    const production = new CacheKeys(parseEnv({ NODE_ENV: 'development' }));
    expect(production.keyspace).toBe('gsm:development:');
    expect<string>(production.version('catalog')).toBe('gsm:development:cache:version:catalog');
    expect(keys.keyspace).toBe('gsm:test:');
  });

  it('refuse parts that could break the key shape or a SCAN pattern', () => {
    for (const bad of ['', 'a:b', 'a b', 'a*', 'a?', 'a[1]', 'a\\b', 'a\n', 'x'.repeat(129), '../etc']) {
      expect(() => keys.version(bad), JSON.stringify(bad)).toThrow(/must match/);
      expect(() => keys.semaphore(bad), JSON.stringify(bad)).toThrow(/must match/);
      expect(() => keys.prefix('module', bad), JSON.stringify(bad)).toThrow(/must match/);
    }
    expect(() => keys.prefix('', 'entity')).toThrow(/must match/);
    expect(() => keys.prefix('m', 'e', 'bad:id')).toThrow(/must match/);
  });

  it('accept ids with dots, dashes, underscores and digits', () => {
    expect<string>(keys.semaphore('supplier_12.v-2')).toBe('gsm:test:semaphore:supplier_12.v-2');
  });
});

describe('familyOf', () => {
  it('is module:entity of the key', () => {
    expect(familyOf('gsm:test:catalog:service:12')).toBe('catalog:service');
    expect(familyOf('gsm:production:cache:version:catalog')).toBe('cache:version');
    expect(familyOf(keys.prefix('orders', 'order'))).toBe('orders:order');
  });

  it('is "unknown" for text that is not shaped like a key', () => {
    expect(familyOf('hello')).toBe('unknown');
    expect(familyOf('a:b:c')).toBe('unknown');
  });
});

describe('docs/cache-keys.md', () => {
  const builders = Object.getOwnPropertyNames(CacheKeys.prototype).filter((name) => name !== 'constructor');

  it('has a CACHE_KEY_FAMILIES entry for every CacheKeys builder, and a builder for every entry', () => {
    expect([...CACHE_KEY_FAMILIES.map((family) => family.builder)].sort()).toEqual([...builders].sort());
  });

  it('lists every family with its pattern, owner, TTL, invalidation and builder', () => {
    for (const family of CACHE_KEY_FAMILIES) {
      const row = docs.split('\n').find((line) => line.startsWith(`| \`${family.pattern}\` |`));
      expect(row, `docs/cache-keys.md has no row for ${family.pattern} (builder ${family.builder})`).toBeDefined();
      // The document wraps code names in backticks; the descriptors are plain text.
      const plain = (row ?? '').replaceAll('`', '');
      expect(plain, family.builder).toContain(family.owner);
      expect(plain, family.builder).toContain(family.ttl);
      expect(plain, family.builder).toContain(family.invalidation);
      expect(plain, family.builder).toMatch(new RegExp(`\\| ${family.builder} \\|$`));
    }
  });

  it('documents no key family that has no builder', () => {
    const documented = docs
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) => /^\| `([^`]+)`/.exec(line)?.[1]);
    expect(documented.sort()).toEqual(CACHE_KEY_FAMILIES.map((family) => family.pattern).sort());
  });

  it('gives every family a TTL and an invalidation rule (decision 022: always a TTL, always a way out)', () => {
    for (const family of CACHE_KEY_FAMILIES) {
      expect(family.ttl.length, family.builder).toBeGreaterThan(0);
      expect(family.invalidation.length, family.builder).toBeGreaterThan(0);
      expect(family.pattern, family.builder).toMatch(/\{/);
    }
  });
});
