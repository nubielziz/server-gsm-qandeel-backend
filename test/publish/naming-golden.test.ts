// The measured acceptance of the shop naming on the 1157 real supplier names (feature 31, plan section 8.2): the figures of the
// prototype, the per-group invariance of the facts, and a snapshot of every row a person reads as a diff after a rule change.
// Regenerate the snapshot after a deliberate rule change: GSM_UPDATE_NAMING_SNAPSHOT=1 bun test test/publish/naming-golden.test.ts,
// then `bunx prettier --write test/fixtures/publish/expected-names.json`.
import { describe, expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSlug } from '../../src/modules/storefront/domain/slug';
import {
  HARD_NAMING_FLAGS,
  type NamedService,
  assignSlugs,
  cleanTitle,
  nameAll,
} from '../../src/modules/storefront/publish/domain/naming';

interface SupplierName {
  readonly n: number;
  readonly type: 'IMEI' | 'SERVER';
  readonly group: string;
  readonly cost: string;
  readonly name: string;
}

interface ExpectedName {
  readonly n: number;
  readonly title: string;
  readonly slug: string;
  readonly brand: string;
  readonly carrier: string;
  readonly country: string;
  readonly flags: readonly string[];
}

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'publish');
const SNAPSHOT = join(FIXTURES, 'expected-names.json');
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

const fixture = JSON.parse(readFileSync(join(FIXTURES, 'supplier-names.json'), 'utf8')) as SupplierName[];
const rows = fixture.map((row) => ({
  name: row.name,
  group: row.group,
  type: row.type === 'IMEI' ? ('imei' as const) : ('server' as const),
}));
const named = nameAll(rows);
const slugs = assignSlugs(
  named.map((row, i) => ({ id: fixture[i]?.n ?? i, slugBase: row.slugBase })),
  [],
);
const results = named.map((row, i) => ({
  n: fixture[i]?.n ?? i,
  row,
  slug: slugs[i]?.slug ?? '',
  flags: slugs[i]?.suffixed === true ? [...row.flags, 'slug_suffixed'] : [...row.flags],
}));
const count = (test: (row: NamedService, i: number) => boolean) => named.filter(test).length;
const byN = (n: number) => results.find((result) => result.n === n);

/** JSON with every non-ASCII character as a `\u` escape (fact 25: the guard reads test files). */
function asciiJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2).replace(/[\u007f-\uFFFF]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

describe('the shop naming on the 1157 real supplier names (plan section 8.2)', () => {
  it('reads all 1157 lines, the pipes inside groups and names included', () => {
    expect(fixture).toHaveLength(1157);
    expect(fixture.filter((row) => row.type === 'IMEI')).toHaveLength(627);
    expect(new Set(fixture.map((row) => row.group)).size).toBe(254);
  });

  it('finds a brand for at least 1048 (the prototype 1054; 1055 read from the uncut title)', () => {
    expect(count((row) => row.brand !== '')).toBeGreaterThanOrEqual(1048);
    expect(count((row) => row.brand !== '')).toBe(1055);
  });

  it('finds a carrier for at least 187 (the prototype 188)', () => {
    expect(count((row) => row.carrier !== '')).toBeGreaterThanOrEqual(187);
    expect(count((row) => row.carrier !== '')).toBe(188);
  });

  it('finds a country for at least 275 (the prototype 277)', () => {
    expect(count((row) => row.country !== '')).toBeGreaterThanOrEqual(275);
    expect(count((row) => row.country !== '')).toBe(277);
  });

  it('gives at least 1070 titles that are not empty and at most 80 characters (the prototype 1082)', () => {
    // The floor was 1076 in plan 8.2; the lead lowered it to 1070 after the B2 review: the cut never drops a clause that states
    // a restriction or a refusal (`[Not Support Single SIM Phone]`, `(No Refund any issue)`), so those titles stay longer.
    expect(count((row) => row.title !== '' && row.title.length <= 80)).toBeGreaterThanOrEqual(1070);
    expect(count((row) => row.title !== '' && row.title.length <= 80)).toBe(1071);
  });

  it('gives at least 1149 distinct slug bases before any suffix, the empty one counted once', () => {
    expect(new Set(named.map((row) => row.slugBase)).size).toBeGreaterThanOrEqual(1149);
  });

  it('gives all 1156 non-empty slugs unique, valid and at most 120 characters after assignSlugs', () => {
    const made = slugs.map((slug) => slug.slug).filter((slug) => slug !== '');
    expect(made).toHaveLength(1156);
    expect(new Set(made).size).toBe(1156);
    expect(made.every((slug) => isSlug(slug))).toBe(true);
  });

  it('leaves no emoji, Arabic script, pipe, entity, double space or unpaired bracket in any title', () => {
    const paired = (title: string) => {
      let depth = 0;
      for (const ch of title) {
        if (ch === '(' || ch === '[') depth += 1;
        if (ch === ')' || ch === ']') depth -= 1;
        if (depth < 0) return false;
      }
      return depth === 0;
    };
    const dirty = named.filter(
      ({ title }) =>
        /\p{Extended_Pictographic}/u.test(title) ||
        ARABIC.test(title) ||
        title.includes('|') ||
        /&(?:#x?[0-9a-f]+|[a-z]{2,6});/i.test(title) ||
        title.includes('  ') ||
        !paired(title),
    );
    expect(dirty).toEqual([]);
  });

  it('sends at most 60 rows to blocked or review by the name alone (59 on this list)', () => {
    const waiting = count(
      (row) => row.title === '' || row.title.length > 200 || row.flags.some((flag) => HARD_NAMING_FLAGS.has(flag)),
    );
    expect(waiting).toBeLessThanOrEqual(60);
    expect(waiting).toBe(59);
  });

  it('changes no title when a clean title is cleaned again', () => {
    const changed = named.filter(
      (row, i) => row.title !== '' && cleanTitle(row.title, rows[i]?.type ?? 'imei') !== row.title,
    );
    expect(changed).toEqual([]);
  });

  it('gives every row the same brand, carrier and country when each supplier group is named alone (254 calls)', () => {
    const groups = new Map<string, number[]>();
    rows.forEach((row, i) => groups.set(row.group, [...(groups.get(row.group) ?? []), i]));
    expect(groups.size).toBe(254);
    const differ: number[] = [];
    for (const indexes of groups.values()) {
      nameAll(indexes.map((i) => rows[i] ?? rows[0]!)).forEach((alone, k) => {
        const whole = named[indexes[k] ?? 0];
        if (alone.brand !== whole?.brand || alone.carrier !== whole.carrier || alone.country !== whole.country) {
          differ.push(fixture[indexes[k] ?? 0]?.n ?? -1);
        }
      });
    }
    expect(differ).toEqual([]);
  });

  it('reads the three brands the uncut title changes against the prototype (plan section 3.5)', () => {
    expect(byN(60)?.row.brand).toBe('Apple');
    expect(byN(1028)?.row.brand).toBe('Apple');
    expect(byN(80)?.row.brand).toBe(''); // the uncut title names Apple and Samsung
  });

  it('flags both rows of each of the 8 exact duplicate pairs and suffixes the second', () => {
    const duplicates = results.filter((result) => result.flags.includes('duplicate_name')).map((result) => result.n);
    expect(duplicates).toEqual([71, 72, 88, 89, 489, 490, 529, 530, 821, 822, 823, 826, 828, 829, 1154, 1155]);
    expect(results.filter((result) => result.flags.includes('slug_suffixed')).map((result) => result.n)).toEqual([
      72, 89, 490, 530, 826, 828, 829, 1155,
    ]);
  });

  it('matches the snapshot of every row', () => {
    const actual: ExpectedName[] = results.map(({ n, row, slug, flags }) => ({
      n,
      title: row.title,
      slug,
      brand: row.brand,
      carrier: row.carrier,
      country: row.country,
      flags,
    }));
    if (process.env.GSM_UPDATE_NAMING_SNAPSHOT === '1') writeFileSync(SNAPSHOT, asciiJson(actual));
    const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as ExpectedName[];
    expect(actual).toEqual(expected);
  });
});
