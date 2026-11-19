// Unit tests of the services documents (feature 29, plan section 4.2 and step 0): what a document holds, the typo-safe fields, and the
// hash the reconcile compares.
import { describe, expect, it } from 'bun:test';
import {
  type DocumentSource,
  buildServiceDocument,
  documentHash,
} from '@src/modules/storefront/search/domain/documents';
import { SERVICE_FIELDS } from '@src/modules/storefront/search/domain/services-schema';

const source = (over: Partial<DocumentSource> = {}): DocumentSource => ({
  serviceId: 42,
  type: 'imei',
  serviceName: 'Samsung SM-A525F unlock (supplier 7)',
  categoryId: 3,
  categoryName: 'Samsung 5G',
  title: 'Galaxy A52 Unlock 🔓 (SM-A525F)',
  summary: 'Unlock your Samsung &amp; keep warranty. 24h delivery.',
  brand: '  Samsung   ',
  carrier: 'AT&T',
  country: 'us',
  isFeatured: true,
  sort: 4,
  sales30d: 12,
  listedAt: null,
  createdAt: new Date('2026-11-01T10:00:00.000Z'),
  networks: ['AT&T', 'T-Mobile 5G'],
  models: ['SM-A525F', 'SM-A526B'],
  inStock: false,
  ...over,
});

describe('buildServiceDocument', () => {
  it('holds only public, English, price-free facts, with the shown title and typo-safe copies', () => {
    const document = buildServiceDocument(source());
    expect(document).toMatchObject({
      id: '42',
      title: 'Galaxy A52 Unlock (SM-A525F)',
      title_words: 'galaxy unlock',
      title_sort: 'galaxy a52 unlock sm-a525f',
      summary: 'Unlock your Samsung & keep warranty. delivery.',
      brand: 'Samsung',
      brand_key: 'samsung',
      carrier: 'AT&T',
      carrier_key: 'at&t',
      country: 'US',
      country_names: ['united states', 'usa', 'america'],
      networks: ['att', 't-mobile'],
      category: 'Samsung',
      category_id: 3,
      type: 'imei',
      models: ['sm-a525f', 'sm-a526b'],
      popularity: 12,
      featured: true,
      in_stock: false,
      sort: 4,
      listed_at: Math.floor(Date.parse('2026-11-01T10:00:00.000Z') / 1000),
    });
    expect(document.codes).toEqual(['a52', 'sma525f', 'sm', 'a525f', 'sma526b', 'a526b']);
    expect(document.joins).toEqual(expect.arrayContaining(['galaxya52', 'a52unlock']));
    // Nothing the shop must not show: no price, no cost, no supplier, no internal name.
    expect(JSON.stringify(document)).not.toContain('supplier');
    expect(Object.keys(document).sort()).toEqual(
      ['id', ...SERVICE_FIELDS.map((field) => field.name)].filter((name) => name in document).sort(),
    );
  });

  it('never puts a token with a digit in a field searched with typos (step 0)', () => {
    const document = buildServiceDocument(source({ brand: 'Galaxy S23', carrier: 'EE 4GEE', categoryName: '4G 5G' }));
    for (const field of ['title_words', 'summary', 'brand', 'carrier', 'category'] as const) {
      expect(document[field] ?? '', field).not.toMatch(/\d/);
    }
    for (const value of [...(document.networks ?? []), ...(document.country_names ?? [])])
      expect(value).not.toMatch(/\d/);
    // The codes read the brand and the carrier too (3-24 characters: `4g` and `5g` are too short to be codes).
    expect(document.codes).toEqual(expect.arrayContaining(['s23', '4gee']));
    expect(document.codes).not.toContain('5g');
    expect(document.category).toBe('');
  });

  it('leaves out empty optional fields and uses created_at when the listing was never published', () => {
    const document = buildServiceDocument(
      source({ summary: '', brand: '', carrier: '', country: '', networks: [], models: [], listedAt: null }),
    );
    for (const field of [
      'summary',
      'brand',
      'carrier',
      'brand_key',
      'carrier_key',
      'country',
      'country_names',
      'networks',
      'models',
    ]) {
      expect(document, field).not.toHaveProperty(field);
    }
    expect(buildServiceDocument(source({ listedAt: new Date('2026-11-05T00:00:00.000Z') })).listed_at).toBe(
      Math.floor(Date.parse('2026-11-05T00:00:00.000Z') / 1000),
    );
  });

  it('hashes every field but the hash, so any change of a fact changes the hash', () => {
    const one = buildServiceDocument(source());
    const { hash, ...rest } = one;
    expect(hash).toBe(documentHash(rest));
    expect(buildServiceDocument(source()).hash).toBe(hash);
    expect(buildServiceDocument(source({ inStock: true })).hash).not.toBe(hash);
    expect(buildServiceDocument(source({ sales30d: 13 })).hash).not.toBe(hash);
  });
});
