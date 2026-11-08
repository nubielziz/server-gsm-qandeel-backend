// Unit tests of the landing-page generator rules (feature 19): list cleaning, the models of a run, the combinations and their slugs, the
// draft text and the refusal sentence.
import { describe, expect, it } from 'bun:test';
import {
  STOREFRONT_GENERATE_MAX_PER_RUN,
  cleanList,
  combinationsOf,
  draftBody,
  draftTitle,
  overCapDetail,
  resolveModels,
  splitUsableModels,
  splitUsableNetworks,
} from './page-generator';

const catalogue = (ofBrands: Array<[string, string]> = [], ofNames: Array<[string, string]> = []) => ({
  ofBrands: ofBrands.map(([brand, name]) => ({ brand, name })),
  ofNames: ofNames.map(([brand, name]) => ({ brand, name })),
});

describe('cleanList', () => {
  it('trims, splits on commas and new lines, drops blanks and repeats (ignoring case) and keeps the first spelling', () => {
    expect(cleanList(['  AT&T ', 'EE, Three\nO2\r\n', '', ' , ', 'at&t'])).toEqual(['AT&T', 'EE', 'Three', 'O2']);
    expect(cleanList([])).toEqual([]);
  });
});

describe('resolveModels', () => {
  it('uses the catalogue models of the chosen brands when no model is typed', () => {
    const rows = catalogue([
      ['Apple', 'iPhone 12'],
      ['Apple', 'iPhone 13'],
    ]);
    expect(resolveModels(['Apple'], [], rows)).toEqual(rows.ofBrands);
  });

  it('uses the typed models, with the catalogue brand when it knows the model (the chosen brand first) and the typed spelling of the catalogue', () => {
    const known = catalogue(
      [],
      [
        ['Samsung', 'Galaxy S23'],
        ['Apple', 'Galaxy S23'],
      ],
    );
    expect(resolveModels(['Apple'], ['galaxy s23'], known)).toEqual([{ brand: 'Apple', name: 'Galaxy S23' }]);
    expect(resolveModels([], ['GALAXY S23'], known)).toEqual([{ brand: 'Samsung', name: 'Galaxy S23' }]);
  });

  it('puts a typed model the catalogue lacks under the one typed brand, else under no brand', () => {
    expect(resolveModels(['Fairphone'], ['Fairphone 5'], catalogue())).toEqual([
      { brand: 'Fairphone', name: 'Fairphone 5' },
    ]);
    expect(resolveModels(['A', 'B'], ['Fairphone 5'], catalogue())).toEqual([{ brand: '', name: 'Fairphone 5' }]);
    expect(resolveModels([], ['Fairphone 5'], catalogue())).toEqual([{ brand: '', name: 'Fairphone 5' }]);
  });
});

describe('combinationsOf', () => {
  const models = [
    { brand: 'Apple', name: 'iPhone 13' },
    { brand: 'Samsung', name: 'Galaxy S23' },
  ];

  it('makes a draft for each model x network, model by model, with the title and the slug of the demo', () => {
    const { drafts } = combinationsOf(models, ['AT&T', 'Vodafone UK']);
    expect(drafts.map((draft) => [draft.title, draft.slug])).toEqual([
      ['Unlock iPhone 13 on AT&T', 'unlock-iphone-13-on-atandt'],
      ['Unlock iPhone 13 on Vodafone UK', 'unlock-iphone-13-on-vodafone-uk'],
      ['Unlock Galaxy S23 on AT&T', 'unlock-galaxy-s23-on-atandt'],
      ['Unlock Galaxy S23 on Vodafone UK', 'unlock-galaxy-s23-on-vodafone-uk'],
    ]);
    expect(draftTitle('iPhone 13', 'AT&T')).toBe('Unlock iPhone 13 on AT&T');
  });

  it('merges a combination whose slug an earlier one of the run already has into it, and keeps the first', () => {
    const { drafts } = combinationsOf(
      [
        { brand: 'Apple', name: 'iPhone 13' },
        { brand: 'Apple', name: 'iPhone-13' },
      ],
      ['EE'],
    );
    expect(drafts.map((draft) => draft.model)).toEqual(['iPhone 13']);
  });

  it('names a model or network that makes no slug', () => {
    expect(combinationsOf([{ brand: '', name: 'هاتف' }], ['EE']).unusable).toEqual({ field: 'models', value: 'هاتف' });
    expect(combinationsOf(models, ['شبكة']).unusable).toEqual({ field: 'networks', value: 'شبكة' });
    expect(combinationsOf(models, ['EE']).unusable).toBeUndefined();
  });
});

describe('splitUsableModels', () => {
  it('sets aside the models whose name has no Latin letter or digit, and keeps the order of the rest', () => {
    const { usable, unusable } = splitUsableModels([
      { brand: 'Apple', name: 'iPhone 13' },
      { brand: 'Huawei', name: 'هاتف' },
      { brand: 'Xiaomi', name: '红米 Note' },
      { brand: 'Xiaomi', name: '红米' },
    ]);
    expect(usable.map((model) => model.name)).toEqual(['iPhone 13', '红米 Note']);
    expect(unusable.map((model) => model.name)).toEqual(['هاتف', '红米']);
  });
});

describe('splitUsableNetworks', () => {
  it('sets aside the carriers whose name has no Latin letter or digit, and keeps the order of the rest', () => {
    const { usable, unusable } = splitUsableNetworks(['AT&T', 'شبكة', '3 Mobile', '网络']);
    expect(usable).toEqual(['AT&T', '3 Mobile']);
    expect(unusable).toEqual(['شبكة', '网络']);
  });
});

describe('the draft text and the refusal', () => {
  it('writes a short Markdown body that names the title, the device and the network', () => {
    const body = draftBody({
      brand: 'Apple',
      model: 'iPhone 13',
      network: 'AT&T',
      title: 'Unlock iPhone 13 on AT&T',
      slug: 'x',
    });
    expect(body.startsWith('# Unlock iPhone 13 on AT&T\n\nDraft for review.')).toBe(true);
    expect(body).toContain('the Apple iPhone 13 locked to AT&T');
    expect(draftBody({ brand: '', model: 'Fairphone 5', network: 'EE', title: 't', slug: 'x' })).toContain(
      'the Fairphone 5 locked to EE',
    );
  });

  it('says the limit and the count the way b2c-15 words it', () => {
    expect(STOREFRONT_GENERATE_MAX_PER_RUN).toBe(50);
    expect(overCapDetail(51)).toBe('This run would create 51 pages; the limit is 50 per run. Narrow the lists.');
  });
});
