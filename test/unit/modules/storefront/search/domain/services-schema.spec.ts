// Unit tests of the services schema and the names of an environment (feature 29, plan sections 3.3 and 4.2).
import { describe, expect, it } from 'bun:test';
import {
  SERVICES_SCHEMA_VERSION,
  SERVICE_FIELDS,
  SearchNames,
  collectionStamp,
  servicesSchema,
} from '@src/modules/storefront/search/domain/services-schema';

describe('servicesSchema', () => {
  it('links the synonym set and no curation set, sorts by popularity, and searches no field with typos that could hold a digit token', () => {
    const schema = servicesSchema('p_services_v2_20261116000000', 'p_synonyms');
    expect(schema).toMatchObject({ default_sorting_field: 'popularity', synonym_sets: ['p_synonyms'] });
    // Decision 068: pins are retired, so a collection of schema version 2 links no curation set.
    expect(schema).not.toHaveProperty('curation_sets');
    expect(SERVICES_SCHEMA_VERSION).toBe(2);
    expect(schema).not.toHaveProperty('token_separators');
    expect(SERVICE_FIELDS.find((field) => field.name === 'hash')).toEqual({
      name: 'hash',
      type: 'string',
      index: false,
    });
    expect(SERVICE_FIELDS.find((field) => field.name === 'title')).toEqual({ name: 'title', type: 'string' });
  });
});

describe('SearchNames', () => {
  const names = new SearchNames('gsm_29_test_');

  it('builds the names of plan section 3.3', () => {
    const at = new Date('2026-11-16T03:40:05.123Z');
    expect(collectionStamp(at)).toBe('20261116034005');
    expect(names.collection('services', at)).toBe(`gsm_29_test_services_v${SERVICES_SCHEMA_VERSION}_20261116034005`);
    expect(names.alias('services')).toBe(`gsm_29_test_services_v${SERVICES_SCHEMA_VERSION}`);
    expect(names.alias('terms', 7)).toBe('gsm_29_test_terms_v7');
    expect(names.synonymSet).toBe('gsm_29_test_synonyms');
    expect(names.retiredCurationSet).toBe('gsm_29_test_curations');
  });

  it('parses only its own names, never a longer prefix of another run', () => {
    expect(names.parse('gsm_29_test_services_v1_20261116034005')).toEqual({
      kind: 'services',
      version: 1,
      stamp: '20261116034005',
    });
    expect(names.parse('gsm_29_test_ab12_services_v1_20261116034005')).toBeNull();
    expect(names.parse('gsm_29_test_golden_services')).toBeNull();
    expect(names.parseAlias('gsm_29_test_terms_v2')).toEqual({ kind: 'terms', version: 2 });
    expect(names.parseAlias('gsm_development_terms_v2')).toBeNull();
  });
});
