// Tests of the carrier and country detection (feature 31, plan sections 3.5 and 8.2): every trap of A3 section 5.3 and the order
// of the sources (the title, the group, the carriers). `#n` is the line of the real name.
import { describe, expect, it } from 'bun:test';
import { detectCountries, detectGeo } from '@src/modules/storefront/publish/domain/naming/carrier-country';

const imei = (title: string, group = 'Unlock Services') => detectGeo(title, title, group, 'imei');

describe('detectGeo: the traps of A3 section 5.3', () => {
  it('reads no country from a tool named CDMA YEMEN (#152)', () => {
    const geo = detectGeo(
      'CDMA YEMEN TOOL PRO 10 Days',
      'CDMA YEMEN TOOL PRO 10 Days',
      'CDMA YEMEN Team - Tool',
      'server',
    );
    expect(geo.country).toBeNull();
    expect(geo.countries).toEqual([]);
  });

  it('reads no country from "China Supported", "China Support", "CHINA NOT SUPPORTED" or "Non-China" (#31, #849, #1099, #1096)', () => {
    expect(
      imei('Amrr iCloud A12+Tool Version 2 [iOS 16 - 26.1 ONLY] China Supported No Notifications').country,
    ).toBeNull();
    expect(imei('Realme Network Unlock 172 Digit Code Service [China Support] Dual Sim Only').country).toBeNull();
    expect(imei('Xiaomi Mi Account Remove Clean Only CHINA NOT SUPPORTED').country).toBeNull();
    expect(imei('Mi Account Removal - Global Service, Non-China').country).toBeNull();
  });

  it('reads no country from a web address ending in a country code (#907)', () => {
    const geo = detectGeo('SamsungTool.us Credits For Existing User', '', 'Samsung Tool KG', 'server');
    expect(geo.country).toBeNull();
  });

  it('reads no carrier and no country from a router code list (#877)', () => {
    const name = 'Orange Vegas, Miami, Dallas, Sydney unlock code by imei';
    expect(detectGeo(name, name, 'Router Code', 'imei')).toMatchObject({ carrier: null, country: null });
    expect(detectGeo('Orange-Panama Huawei E5573', 'Orange-Panama Huawei E5573', 'Router Code', 'imei')).toMatchObject({
      carrier: null,
      country: null,
    });
  });

  it('never reads the bare codes ID, SE, NO, AT, AU or IN as a country', () => {
    expect(imei('Apple ID Remove Service').country).toBeNull();
    expect(imei('iPhone SE Unlock').country).toBeNull();
    expect(imei('NO REFUND iPhone Unlock').country).toBeNull();
    expect(imei('Unlock AU KDDI iPhone').country).toBe('JP');
    expect(detectCountries('Windows IN MacOs')).toEqual([]);
  });

  it('accepts the bare codes US, UK and JP', () => {
    expect(imei('US AT&T Clean Unlock').country).toBe('US');
    expect(imei('UK Vodafone iPhone').country).toBe('GB');
    expect(imei('JP - KDDI Finance Check [IMEI]')).toMatchObject({ carrier: 'KDDI (au)', country: 'JP' });
  });

  it('reads the carriers that are common words only in their form: Wind before Canada, TIM as Tim Brazil, EE in capitals', () => {
    expect(imei('Freedom, Wind Canada - iPhone All Models')).toMatchObject({
      carrier: 'Freedom',
      carriers: ['Freedom', 'Wind'],
      country: 'CA',
    });
    expect(imei('Tim Brazil Unbarring / Cleaning Service By IMEI')).toMatchObject({ carrier: 'TIM', country: 'BR' });
    expect(imei('Free unlock, see the TIM list').carrier).toBeNull();
    expect(imei('Unlock all models fee').carrier).toBeNull();
    expect(imei('UK EE / T-Mobile / Orange iPhone').carrier).toBe('EE');
  });

  it('reads a demonym and the spellings of the suppliers (Egyptian, U.S.A, Nederland)', () => {
    expect(detectGeo('Mix React Egyptian Facebook', '', 'Social Media Followers', 'server').country).toBe('EG');
    expect(imei('U.S.A AT&T Unlock - iPhone 14 Series').country).toBe('US');
    expect(imei('Xiaomi Mi Account Unlock Service [Nederland] Clean IMEI').country).toBe('NL');
  });

  it('reads no single country from two countries in one name', () => {
    expect(imei('Ecuador Cleaning Service from colombia blacklist')).toMatchObject({
      country: null,
      countrySource: 'multi',
    });
  });
});

describe('detectGeo: the sources', () => {
  it('reads carriers for IMEI services only', () => {
    expect(detectGeo('AT&T Gift Card', '', 'Gift Cards', 'server').carrier).toBeNull();
    expect(imei('AT&T USA iPhone Unlock').carrier).toBe('AT&T');
  });

  it('takes the carrier named first and settles the country from the carriers all named share', () => {
    expect(imei('T-Mobile / Sprint / MetroPCS iPhone XR to 13 Pro Max Premium Network Unlock Service')).toMatchObject({
      carrier: 'T-Mobile',
      country: 'US',
      countrySource: 'carrier',
    });
  });

  it('reads the one country word of the group when the title names none', () => {
    expect(imei('iPhone All Models Unlock', 'Canada NETWORK UNLOCKED SIM NOT SUPPORTED')).toMatchObject({
      country: 'CA',
      countrySource: 'group',
    });
  });

  it('reads the carrier from the group when the title names none', () => {
    expect(imei('iPhone 6G 16GB Unlocked Network', 'Egypt Mobinil Network Unlock')).toMatchObject({
      carrier: 'Mobinil',
      country: 'EG',
    });
  });

  it('gives no country for "All Countries", "Worldwide" or a list of more than three', () => {
    expect(imei('Claro iPhone - All Countries & iPhone Models')).toMatchObject({
      carrier: 'Claro',
      country: null,
      countrySource: 'multi',
    });
    expect(imei('ZTE WORLDWIDE FACTORY NCK CODE').country).toBeNull();
    const list = imei('Xiaomi Mi Account Unlock Service [Romania / Sweden / Spain / Slovenia / Andorra] Clean IMEI');
    expect(list.country).toBeNull();
    expect(list.countries.length).toBeGreaterThan(3);
  });

  it('settles two country words only through the one country of the named carriers', () => {
    expect(imei('AT&T USA / Mexico iPhone Unlock')).toMatchObject({
      carrier: 'AT&T',
      country: 'US',
      countrySource: 'name_carrier',
    });
    expect(imei('Vodafone Ireland / UK iPhone Unlock')).toMatchObject({ carrier: 'Vodafone', country: null });
  });
});

describe('detectCountries', () => {
  it('reads the English names of countryNames backwards, withdrawn codes skipped', () => {
    expect(detectCountries('Germany Unlock')).toEqual(['DE']);
    expect(detectCountries('Serbia / Montenegro')).toEqual(expect.arrayContaining(['RS', 'ME']));
    expect(detectCountries('Saudi Arabia iTunes')).toEqual(['SA']);
  });
});
