// Carrier data of the shop detection (feature 31, plan section 3.5; A3 section 5.1): the networks an IMEI unlock names, their
// country, and the countries of the carriers that work in several. Pure data; tested in lexicon.spec.ts.

/** One carrier: its display name, the words that name it, its country (or `null`), and whether it works in several countries. */
export interface CarrierEntry {
  /** The carrier as the shop shows it (`AT&T`). */
  readonly name: string;
  /** The words that name it in a service name or group (case-insensitive unless the entry says otherwise). */
  readonly pattern: RegExp;
  /** Its ISO-2 country when it has one home country, else `null`. */
  readonly country: string | null;
  /** True when it works in several countries: its country comes from {@link CARRIER_COUNTRIES} or a country word. */
  readonly multi: boolean;
}

const carrier = (name: string, pattern: RegExp, country: string | null, multi = false): CarrierEntry => ({
  name,
  pattern,
  country,
  multi,
});

/**
 * The carriers the 1157 real names use, in the prototype's order.
 *
 * Why: A3 section 5.1: 188 IMEI names name one of these 41. The common-word traps of A3 section 5.3 are in the patterns: `Wind`
 * only before `Canada`, `TIM` only as `Tim Brazil`, `EE` only in capitals.
 */
export const CARRIERS: readonly CarrierEntry[] = [
  carrier('AT&T', /\bat\s?&\s?t\b|\batt\b|\bat&amp;t\b/i, 'US'),
  carrier('T-Mobile', /\bt[- ]?mobile\b|\btmobile\b/i, 'US', true),
  carrier('Sprint', /\bsprint\b/i, 'US'),
  carrier('Verizon', /\bverizon\b|\bvzw\b/i, 'US'),
  carrier('Cricket', /\bcricket\b/i, 'US'),
  carrier('MetroPCS', /\bmetropcs\b/i, 'US'),
  carrier('US Cellular', /\bus cellular\b/i, 'US'),
  carrier('Xfinity', /\bxfinity\b/i, 'US'),
  carrier('Spectrum', /\bspectrum\b/i, 'US'),
  carrier('Dish Boost', /\bdish boost\b/i, 'US'),
  carrier('TracFone', /\btrac\s?fone\b|straight\s?talk\b/i, 'US'),
  carrier('C Spire', /\bc-?spire\b/i, 'US'),
  carrier('Bell', /\bbell\b/i, 'CA'),
  carrier('MTS', /\bmts\b/i, 'CA', true),
  carrier('Virgin', /\bvirgin\b/i, 'CA', true),
  carrier('Rogers', /\brogers?\b/i, 'CA'),
  carrier('Fido', /\bfido\b/i, 'CA'),
  carrier('Telus', /\btelus\b/i, 'CA'),
  carrier('Koodo', /\bkoodo\b|\bkodoo\b/i, 'CA'),
  carrier('Videotron', /\bvideotron\b/i, 'CA'),
  carrier('Freedom', /\bfreedom\b/i, 'CA', true),
  carrier('Wind', /\bwind\b(?= canada)/i, 'CA'),
  carrier('SaskTel', /\bsask(?:a)?tel\b/i, 'CA'),
  carrier('Vodafone', /\bvodafone\b/i, null, true),
  carrier('EE', /\bEE\b/, 'GB'),
  carrier('O2', /\bo2\b/i, null, true),
  carrier('Three', /\bthree\b|\b3 hutchison\b|\bhutchison\b/i, null, true),
  carrier('Tesco', /\btesco\b/i, 'GB'),
  carrier('Orange', /\borange\b/i, null, true),
  carrier('Eir', /\beir\b/i, 'IE'),
  carrier('Meteor', /\bmeteor\b/i, 'IE'),
  carrier('A1', /\ba1\b|\bmobilkom\b|\btelekom austria\b/i, 'AT'),
  carrier('Telering', /\btelering\b/i, 'AT'),
  carrier('Telstra', /\btelstra\b/i, 'AU'),
  carrier('KDDI (au)', /\bau kddi\b|\bkddi\b/i, 'JP'),
  carrier('NTT Docomo', /\bntt docomo\b|\bdocomo\b/i, 'JP'),
  carrier('SoftBank', /\bsoftbank\b/i, 'JP'),
  carrier('Y!mobile', /\by-?mobile\b|\bymobile\b/i, 'JP'),
  carrier('UQ Mobile', /\buq\b/i, 'JP'),
  carrier('J:COM', /\bjcom\b/i, 'JP'),
  carrier('Mobinil', /\bmobinil\b/i, 'EG'),
  carrier('Claro', /\bclaro\b/i, null, true),
  carrier('TIM', /\btim brazil\b/i, 'BR'),
  carrier('Movistar', /\bmovistar\b/i, null, true),
  carrier('Telcel', /\btelcel\b/i, 'MX'),
  carrier('Bitel', /\bbitel\b/i, 'PE'),
  carrier('Entel', /\bentel\b/i, 'PE'),
];

/**
 * The countries a carrier that works in several countries works in; the countries all the carriers of one name share can settle
 * its country (`T-Mobile | Sprint | MetroPCS` gives US).
 *
 * Why: A3 section 5.1: 40 names name two or more carriers; the intersection resolves them without guessing.
 */
export const CARRIER_COUNTRIES: Readonly<Record<string, readonly string[]>> = {
  'T-Mobile': ['US', 'AT', 'GB', 'NL', 'CZ', 'DE', 'PL'],
  Vodafone: ['GB', 'IE', 'AU', 'DE', 'ES', 'IT', 'NL', 'TR', 'PT'],
  Orange: ['FR', 'GB', 'AT', 'PA', 'ES', 'PL', 'RO', 'BE'],
  Claro: ['BR', 'PE', 'MX', 'CL', 'CO', 'AR', 'EC'],
  Movistar: ['ES', 'PE', 'MX', 'CL', 'CO', 'AR', 'EC'],
  O2: ['GB', 'IE', 'DE', 'CZ'],
  Three: ['GB', 'IE', 'AT', 'AU', 'SE', 'DK'],
  MTS: ['CA', 'RU', 'BY'],
  Virgin: ['CA', 'GB', 'US', 'AU'],
  Freedom: ['CA'],
};
