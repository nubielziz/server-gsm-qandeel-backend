// The relevance golden set of the storefront search (feature 29, slice B2, plan section 8): 60 queries over the fixture catalog plus
// 5 000 generated distractors, run through the real ranking parameters and the real assembly against the Typesense node. Each case is a
// business rule of the owner's examples (completion while typing, typos, synonyms, model codes, pins); a case that fails is a ranking
// bug to fix in `ranking.ts`, never a case to delete. Only the services and terms collections under this suite's own prefix are touched.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SearchResult } from '../../src/infra/search';
import { didYouMean } from '../../src/modules/storefront/search/domain/did-you-mean';
import {
  RESULT_FACETS,
  filterBy,
  NO_FILTERS,
  type ResultFilters,
} from '../../src/modules/storefront/search/domain/filters';
import { imeiIntent } from '../../src/modules/storefront/search/domain/imei-intent';
import { fold } from '../../src/modules/storefront/search/domain/did-you-mean';
import { normaliseQuery, normaliseText } from '../../src/modules/storefront/search/domain/normalise';
import {
  RELEVANCE_SORT,
  nearbyServicesSearch,
  resultsSearch,
  suggestServicesSearch,
  termsSearch,
  termsTypoSearch,
} from '../../src/modules/storefront/search/domain/ranking';
import { STOP_WORDS } from '../../src/modules/storefront/search/domain/terms';
import {
  type EnginePart,
  type FacetLabels,
  type TermHitDocument,
  assembleEnginePart,
  typedPrefix,
} from '../../src/modules/storefront/search/domain/suggest-assembly';
import {
  FIXTURE,
  FIXTURE_CATEGORIES,
  FIXTURE_PINS,
  FIXTURE_SYNONYMS,
  fixtureId,
  fixtureSlug,
} from '../fixtures/search/catalog';
import { type GoldenWorld, buildGoldenWorld, dropGoldenWorld } from '../fixtures/search/world';
import { dropSearchPrefix, engineClient, searchTestPrefix } from '../support/search';

const client = engineClient();
const suite = searchTestPrefix();
const prefix = `${suite}golden_`;
let world: GoldenWorld;

const synonymWords = new Set(FIXTURE_SYNONYMS.flatMap((row) => row.terms.flatMap((term) => term.split(' ').map(fold))));
const synonymPhrases = FIXTURE_SYNONYMS.flatMap((row) => row.terms.map((term) => term.split(' ').map(fold))).filter(
  (words) => words.length > 1,
);
const labels: FacetLabels = {
  brands: new Map(),
  networks: new Map(),
  categories: new Map(Object.values(FIXTURE_CATEGORIES).map((category) => [category.id, category.name])),
};

/** What a suggest answered, with the services as fixture slugs (a generated distractor is its numeric id). */
interface Suggested extends EnginePart {
  readonly intent: 'imei' | null;
  /** The first six candidates (no Postgres re-check in the golden set: every document is searchable). */
  readonly services: string[];
}

async function suggest(raw: string): Promise<Suggested> {
  if (imeiIntent(raw) !== null) {
    return {
      intent: 'imei',
      services: [],
      ghost: null,
      completions: [],
      candidates: [],
      filters: [],
      didYouMean: null,
    };
  }
  const p = typedPrefix(raw);
  const query = normaliseQuery(raw);
  const [terms, services, nearby] = await client.multiSearch<never>([
    termsSearch(world.terms, p.trim()),
    suggestServicesSearch(world.services, query),
    nearbyServicesSearch(world.services, query),
  ]);
  const part = assembleEnginePart({
    raw,
    answer: {
      terms: terms as unknown as SearchResult<TermHitDocument>,
      services: services as unknown as SearchResult<{ id: string }>,
      nearby: nearby as unknown as SearchResult<{ id: string }>,
    },
    labels,
    synonymWords,
    synonymPhrases,
  });
  return { ...part, intent: null, services: part.candidates.slice(0, 6).map((candidate) => fixtureSlug(candidate.id)) };
}

/** What a results page answered. */
interface Resulted {
  readonly slugs: string[];
  readonly ids: string[];
  readonly total: number;
  readonly didYouMean: string | null;
  readonly curated: string[];
}

async function results(raw: string, filters: ResultFilters = NO_FILTERS, limit = 24): Promise<Resulted> {
  const query = normaliseQuery(raw);
  const [main] = await client.multiSearch<{ id: string }>([
    resultsSearch(world.services, query, {
      sortBy: RELEVANCE_SORT,
      offset: 0,
      limit,
      facetBy: RESULT_FACETS,
      filterBy: filterBy(filters),
    }),
  ]);
  let suggestion = didYouMean({
    query,
    hits: main!.hits,
    found: main!.found,
    synonymWords,
    synonymPhrases,
    lastWordComplete: true,
  });
  if (main!.found === 0 && query !== '') {
    const [typo] = await client.multiSearch<{ q: string }>([termsTypoSearch(world.terms, query)]);
    const best = typo!.hits[0]?.document.q;
    suggestion = best !== undefined && best !== normaliseText(query) ? best : null;
  }
  const ids = main!.hits.map((hit) => hit.document.id);
  return {
    ids,
    slugs: ids.map((id) => fixtureSlug(id)),
    total: main!.found,
    didYouMean: suggestion,
    curated: main!.hits.filter((hit) => hit.curated === true).map((hit) => fixtureSlug(hit.document.id)),
  };
}

beforeAll(async () => {
  world = await buildGoldenWorld(client, prefix, { distractors: 5000 });
}, 120_000);

afterAll(async () => {
  await dropGoldenWorld(client, prefix);
  await dropSearchPrefix(suite);
});

/** One case of the golden table: where it is judged (`S` suggest, `R` results, both when unset) and what it expects. */
interface Case {
  readonly n: number;
  readonly q: string;
  readonly only?: 'S' | 'R';
  /** The service expected first (any of several). */
  readonly first?: string | readonly string[];
  /** Must not be first. */
  readonly notFirst?: string;
  /** Asserted when set (`null` asserts "no suggestion"). */
  readonly dym?: string | null;
}

const CASES: readonly Case[] = [
  { n: 1, q: 'samsung frp', first: 'samsung-frp-bypass', dym: null },
  { n: 2, q: 'samsng frp', first: 'samsung-frp-bypass', dym: 'samsung frp' },
  { n: 3, q: 'frp bypas', first: 'samsung-frp-bypass' },
  { n: 4, q: 'google account lock samsung', first: 'samsung-frp-bypass', dym: null },
  { n: 5, q: 'icloud', first: 'iphone-icloud-removal' },
  { n: 6, q: 'iclod', first: 'iphone-icloud-removal', dym: 'icloud' },
  { n: 7, q: 'activation lock', first: 'iphone-icloud-removal', dym: null },
  { n: 8, q: 'at&t', first: 'att-usa-iphone-unlock' },
  { n: 9, q: 'att', first: 'att-usa-iphone-unlock' },
  { n: 10, q: 'AT&T iphone unlock', first: 'att-usa-iphone-unlock' },
  { n: 11, q: 'tmobile', first: 'tmobile-usa-unlock' },
  { n: 12, q: 't-mobile', first: 'tmobile-usa-unlock' },
  { n: 13, q: 'SM-A525F', first: 'galaxy-a52-unlock-sm-a525f', dym: null },
  { n: 14, q: 'sm a525f', first: 'galaxy-a52-unlock-sm-a525f' },
  { n: 15, q: 'sma525f', first: 'galaxy-a52-unlock-sm-a525f' },
  { n: 16, q: 'a525f', first: 'galaxy-a52-unlock-sm-a525f' },
  { n: 17, q: 'SM-A526F', notFirst: 'galaxy-a52-unlock-sm-a525f' },
  { n: 18, q: 'SM-A528B', first: 'galaxy-a52s-unlock-sm-a528b' },
  { n: 19, q: 'iphone15promax', first: 'iphone-15-pro-max-unlock', dym: null },
  { n: 20, q: 'iphone 15 pro max', first: 'iphone-15-pro-max-unlock', dym: null },
  { n: 21, q: 'carrier unlock iphone 15 pro max', first: 'iphone-15-pro-max-unlock', dym: null },
  { n: 22, q: 'imei check', first: 'imei-blacklist-check', dym: null },
  { n: 23, q: 'gsma check', first: 'imei-blacklist-check', dym: null },
  { n: 24, q: 'clean check', first: 'imei-blacklist-check', dym: null },
  { n: 25, q: 'blaclist check', first: 'imei-blacklist-check', dym: null },
  { n: 26, q: 'knox guard', first: 'samsung-kg-removal', dym: null },
  { n: 27, q: 'kg lock', first: 'samsung-kg-removal', dym: null },
  { n: 28, q: 'huawai frp', first: 'huawei-frp-reset' },
  { n: 29, q: 'xiaomi mi acount', first: 'xiaomi-mi-account-removal' },
  { n: 30, q: 'google pixel frp', first: 'pixel-frp-removal' },
  { n: 31, q: 'vodafon', first: 'vodafone-uk-unlock' },
  { n: 32, q: 'sim unlock vodafone', first: 'vodafone-uk-unlock' },
  { n: 35, q: '  SAMSUNG   FRP  ', first: 'samsung-frp-bypass' },
  { n: 44, q: 'uk unlock', first: ['vodafone-uk-unlock', 'ee-uk-unlock'], dym: null },
  { n: 47, q: 'a525', only: 'S', first: 'galaxy-a52-unlock-sm-a525f' },
  { n: 48, q: 'sm-g99', only: 'S', first: 'samsung-network-unlock-all-models' },
  { n: 49, q: 'iphone15pr', only: 'S', first: 'iphone-15-pro-max-unlock' },
  { n: 52, q: 'united kingdom unlock', first: ['vodafone-uk-unlock', 'ee-uk-unlock'] },
  { n: 53, q: 'usa iphone unlock', first: 'att-usa-iphone-unlock' },
  { n: 54, q: 'samsung frp', notFirst: 'android-account-removal-pro' },
  {
    n: 55,
    q: 'iphone 15 pro max unlock',
    first: 'iphone-15-pro-max-unlock',
    notFirst: 'iphone-15-pro-max-unloc-service',
  },
  { n: 60, q: 'samsng a525f', first: 'galaxy-a52-unlock-sm-a525f' },
];

const firstOf = (expected: string | readonly string[]) => (typeof expected === 'string' ? [expected] : [...expected]);

describe('golden set: the first service and the suggestion of each query', () => {
  for (const c of CASES) {
    it(`#${c.n} ${JSON.stringify(c.q)}`, async () => {
      if (c.only !== 'S') {
        const found = await results(c.q);
        if (c.first !== undefined) expect(found.slugs[0]).toBeOneOf(firstOf(c.first));
        if (c.notFirst !== undefined) expect(found.slugs[0]).not.toBe(c.notFirst);
        if (c.dym !== undefined) expect(found.didYouMean).toBe(c.dym);
      }
      if (c.only !== 'R') {
        const shown = await suggest(c.q);
        if (c.first !== undefined) expect(shown.services[0]).toBeOneOf(firstOf(c.first));
        if (c.notFirst !== undefined) expect(shown.services[0]).not.toBe(c.notFirst);
      }
    });
  }
});

describe('golden set: filters, pins and the cases that need their own checks', () => {
  it('#33 unlock with brand=Samsung shows only Samsung hits', async () => {
    const found = await results('unlock', { ...NO_FILTERS, brand: ['Samsung'] }, 48);
    expect(found.ids.length).toBeGreaterThan(10);
    const brands = new Map(world.documents.map((document) => [document.id, document.brand_key]));
    expect(found.ids.every((id) => brands.get(id) === 'samsung')).toBe(true);
  });

  it('#34 unlock: the exact pin comes first, the hidden service is gone, every other hit holds the word', async () => {
    const found = await results('unlock', NO_FILTERS, 250);
    expect(found.slugs[0]).toBe('iphone-15-pro-max-unlock');
    expect(found.curated).toEqual(['iphone-15-pro-max-unlock']);
    expect(found.slugs).not.toContain('motorola-unlock-code');
    const hidden = new Set(FIXTURE_PINS[0]!.hidden.map(String));
    const holdUnlock = world.documents.filter(
      (document) =>
        !hidden.has(document.id) &&
        normaliseText(document.title)
          .split(' ')
          .some((word) => word.startsWith('unlock')),
    );
    // total = pinned + organic matches of `unlock` (the hidden service is in neither).
    expect(found.total).toBe(holdUnlock.length);
    const byId = new Map(world.documents.map((document) => [document.id, document]));
    for (const id of found.ids) {
      const words = normaliseText(byId.get(id)!.title).split(' ');
      expect(words.some((word) => word.startsWith('unlock') || word === 'unloc')).toBe(true);
    }
  });

  it('#56 iphone unlock: the contains pin comes first and every organic hit holds both words', async () => {
    const found = await results('iphone unlock', NO_FILTERS, 100);
    expect(found.slugs[0]).toBe('att-usa-iphone-unlock');
    expect(found.curated).toEqual(['att-usa-iphone-unlock']);
    const byId = new Map(world.documents.map((document) => [document.id, document]));
    for (const id of found.ids) {
      const words = normaliseText(byId.get(id)!.title).split(' ');
      expect(words).toContain('iphone');
      expect(words.some((word) => word === 'unlock' || word === 'unloc')).toBe(true);
    }
  });

  it('#36 sams: the completion samsung exactly once and a Samsung service first', async () => {
    const shown = await suggest('sams');
    expect(shown.completions.filter((completion) => completion.text === 'samsung')).toHaveLength(1);
    const first = world.documents.find((document) => document.id === String(shown.candidates[0]!.id));
    expect(first?.brand_key).toBe('samsung');
  });

  it('#37 icl: the ghost is oud', async () => {
    expect((await suggest('icl')).ghost).toBe('oud');
  });

  it('#38 iphone 15 p: ghost ro and the completion iphone 15 pro max', async () => {
    const shown = await suggest('iphone 15 p');
    expect(shown.ghost).toBe('ro');
    expect(shown.completions.map((completion) => completion.text)).toContain('iphone 15 pro max');
  });

  it('#39 vod: the filter Network: Vodafone', async () => {
    const shown = await suggest('vod');
    expect(shown.filters.map((filter) => filter.label)).toContain('Network: Vodafone');
  });

  it('#40 and #58: an IMEI is an intent, with or without separators, and runs no search', async () => {
    for (const typed of ['356938035643809', '3569 3803 5643 809']) {
      const shown = await suggest(typed);
      expect(shown.intent).toBe('imei');
      expect(shown.services).toEqual([]);
      expect(shown.completions).toEqual([]);
    }
  });

  it('#41-#43 nothing found: 200 with no hits, and no suggestion for gibberish', async () => {
    const gibberish = await results('zzzzzzz');
    expect(gibberish.total).toBe(0);
    expect(gibberish.didYouMean).toBeNull();
    expect((await results('فك شبكة')).total).toBe(0);
    expect((await results('<script>')).total).toBe(0);
  });

  it('#45 samsung a52 frp: the six include the A52 and the FRP service', async () => {
    const shown = await suggest('samsung a52 frp');
    expect(shown.services).toContain('galaxy-a52-unlock-sm-a525f');
    expect(shown.services).toContain('samsung-frp-bypass');
  });

  it('#46 vodafone uk iphone 15 unlok: the six include the Vodafone and the iPhone 15 service', async () => {
    const shown = await suggest('vodafone uk iphone 15 unlok');
    expect(shown.services).toContain('vodafone-uk-unlock');
    expect(shown.services).toContain('iphone-15-pro-max-unlock');
  });

  it('#50 iphone 15 pro m: the ghost is ax', async () => {
    expect((await suggest('iphone 15 pro m')).ghost).toBe('ax');
  });

  it('#51 "samsung ": the ghost is frp, drawn without a double space', async () => {
    const shown = await suggest('samsung ');
    expect(shown.ghost).toBe('frp');
  });

  it('#57 frp: no completion frp 1-24 and none ending in a stop word', async () => {
    const shown = await suggest('frp');
    expect(shown.completions.length).toBeGreaterThan(0);
    for (const completion of shown.completions) {
      expect(completion.text).not.toContain('1-24');
      expect(STOP_WORDS.has(completion.text.split(' ').at(-1)!)).toBe(false);
    }
  });

  it('#59 sma527f: no SM-A52x service in the services or the nearby services, and no code completion', async () => {
    const shown = await suggest('sma527f');
    const a52 = [fixtureId('galaxy-a52-unlock-sm-a525f'), fixtureId('galaxy-a52s-unlock-sm-a528b')].map(String);
    expect(shown.candidates.map((candidate) => String(candidate.id)).some((id) => a52.includes(id))).toBe(false);
    expect(shown.completions.map((completion) => completion.text)).toEqual([]);
    expect((await results('sma527f')).total).toBe(0);
  });

  it('keeps the fixture honest: about 60 hand-written services, 5 000 distractors', () => {
    expect(FIXTURE.length).toBeGreaterThanOrEqual(60);
    expect(world.documents.length).toBe(FIXTURE.length + 5000);
  });
});
