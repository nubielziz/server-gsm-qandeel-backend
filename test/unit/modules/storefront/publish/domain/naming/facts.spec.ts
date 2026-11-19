// Tests of the facts of one service (feature 31, plan sections 3.2, 3.5 and 8.2): brand, carrier and country read from the title
// before the cut, the flags of a row alone, and the title flags the row edit recomputes. `#n` is the line of the real name.
import { describe, expect, it } from 'bun:test';
import {
  HARD_NAMING_FLAGS,
  NAMING_FLAGS,
  NAMING_RULES_VERSION,
  detectFacts,
  orderFlags,
  titleFlags,
} from '@src/modules/storefront/publish/domain/naming/facts';

describe('detectFacts', () => {
  it('reads the facts from the title before the cut (#60 is Apple; its cut title names no Apple word)', () => {
    const facts = detectFacts({
      name: 'AT&T USA Active Line/Active Other/IMEI_issue - iPhone & Generic All imeis Supported',
      type: 'imei',
      group: 'AT&amp;T USA NETWORK UNLOCKED SIM NOT SUPPORTED',
    });
    expect(facts).toMatchObject({ brand: 'Apple', brandKind: 'device', carrier: 'AT&T', country: 'US', flags: [] });
  });

  it('names a remote and a file service by the server rules: the tool is the brand and no carrier is read', () => {
    for (const type of ['remote', 'file', 'server'] as const) {
      expect(detectFacts({ name: 'AT&T Unlock Session 24 Hours', type, group: 'Chimera Tool' })).toMatchObject({
        uncutTitle: 'AT&T Unlock Session 24 Hours',
        brand: 'Chimera Tool',
        brandKind: 'tool',
        carrier: '',
      });
    }
    expect(detectFacts({ name: 'AT&T Unlock Session 24 Hours', type: 'imei', group: 'Chimera Tool' })).toMatchObject({
      uncutTitle: 'AT&T Unlock Session',
      carrier: 'AT&T',
    });
  });

  it('flags a quantity inside the sentence (#960)', () => {
    const facts = detectFacts({
      name: 'Mix React (Love + Like + Support) Egyptian Facebook 1 QNT =1000',
      type: 'server',
      group: 'Social Media Followers',
    });
    expect(facts).toMatchObject({ brand: 'Facebook', country: 'EG', flags: ['quantity_text'] });
  });

  it('flags a list of more than three countries with none chosen (#1120)', () => {
    const facts = detectFacts({
      name: 'Xiaomi Mi Account Unlock Service [ Romania | Sweden | Spain | Nederland | Slovenia | BERMUDA | Andorra ] Clean IMEI',
      type: 'imei',
      group: 'Xiaomi Remove Account - Direct Source Services',
    });
    expect(facts.country).toBe('');
    expect(facts.flags).toEqual(['multi_country']);
  });

  it('flags repaired brackets, a country from the group and a carrier with no country', () => {
    expect(detectFacts({ name: 'Unlock iPhone [Existing Users Only', type: 'imei', group: 'x' }).flags).toEqual([
      'brackets_repaired',
    ]);
    expect(
      detectFacts({ name: 'iPhone 6G 16GB Unlocked Network', type: 'imei', group: 'Egypt Mobinil Network' }),
    ).toMatchObject({ carrier: 'Mobinil', country: 'EG', flags: ['country_from_group'] });
    expect(
      detectFacts({ name: 'Claro iPhone - All Countries & iPhone Models', type: 'imei', group: 'Claro Unlock' }).flags,
    ).toEqual(['carrier_no_country']);
  });

  it('gives empty facts and no flag to an Arabic-only name (#1157)', () => {
    expect(
      detectFacts({ name: '\u0641\u0648\u0631\u0645\u0627\u062A \u062A\u0627\u0628', type: 'imei', group: '' }),
    ).toMatchObject({
      uncutTitle: '',
      brand: '',
      brandKind: null,
      carrier: '',
      country: '',
      flags: [],
    });
  });
});

describe('detectFacts: a service in the Imported category', () => {
  it.each(['server', 'remote'] as const)('a %s service with nothing in its name has no brand', (type) => {
    expect(detectFacts({ name: 'Mystery Service 1 Month', type, group: 'Imported' })).toMatchObject({
      brand: '',
      brandKind: null,
    });
  });
});

describe('titleFlags', () => {
  it('flags a title over 100 characters as long and one of 81-100 as soft', () => {
    expect(titleFlags('x'.repeat(101), 'Apple', 'device')).toEqual(['title_long']);
    expect(titleFlags('x'.repeat(100), 'Apple', 'device')).toEqual(['title_81_100']);
    expect(titleFlags('x'.repeat(80), 'Apple', 'device')).toEqual([]);
  });

  it('flags a tool brand whose first word the title lacks (#949 for SK Unlocker) and a missing brand', () => {
    expect(titleFlags('S.K Tool [3 Months]', 'SK Unlocker', 'tool')).toEqual(['title_lacks_brand']);
    expect(titleFlags('Chimera Tool 1 Year', 'Chimera Tool', 'tool')).toEqual([]);
    expect(titleFlags('Apple ID Account', 'Apple', 'app')).toEqual([]);
    expect(titleFlags('IMEI Check', '', null)).toEqual(['no_brand']);
  });
});

describe('the flag list', () => {
  it('orders flags as the list does and keeps each once', () => {
    expect(orderFlags(['no_brand', 'title_long', 'no_brand'])).toEqual(['title_long', 'no_brand']);
  });

  it('holds the five hard flags of plan section 3.2', () => {
    expect([...HARD_NAMING_FLAGS]).toEqual([
      'title_long',
      'duplicate_name',
      'title_taken',
      'quantity_text',
      'multi_country',
    ]);
    expect(NAMING_FLAGS.slice(0, 5)).toEqual([...HARD_NAMING_FLAGS]);
    expect(NAMING_RULES_VERSION).toBe(1);
  });
});
