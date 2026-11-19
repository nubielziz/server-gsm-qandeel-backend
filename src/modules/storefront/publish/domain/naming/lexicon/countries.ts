// Country data of the shop detection (feature 31, plan section 3.5; A3 sections 5.2-5.4): the words the suppliers use for a country
// beyond the English names of `countryNames`, the codes that name no country today, and the traps. Pure data; tested in
// lexicon.spec.ts and carrier-country.spec.ts.

/**
 * Words for a country that `countryNames` (the search's English names and aliases) does not give, with their ISO-2 code.
 *
 * Why: A3 section 5.4: the reverse map of `countryNames` found a country in 222 names, the prototype in 277; these spellings of
 * the suppliers (`U.S.A`, `Nederland`, `Argentine`, `Egyptians`, `Arabia Saudi`) and the bare `UK` close the gap.
 */
export const EXTRA_COUNTRY_WORDS: readonly (readonly [word: string, code: string])[] = [
  ['U.S.A', 'US'],
  ['UK', 'GB'],
  ['Egyptian', 'EG'],
  ['Egyptians', 'EG'],
  ['Arabia Saudi', 'SA'],
  ['Argentine', 'AR'],
  ['Nederland', 'NL'],
];

/**
 * Two-letter codes for which `countryName` still gives a name but that name no country of today (withdrawn codes such as `DD`,
 * `SU`, `YU`, and the groupings `EU`, `EZ`, `UN`, `QO`): the reverse map skips them, so `Germany` is DE and never DD.
 *
 * Why: the reverse map walks every code from AA to ZZ; without this list a withdrawn code would take the name of today's country.
 */
export const NOT_COUNTRY_CODES: ReadonlySet<string> = new Set(
  'AN BU CS DD DY FX HV NH RH SU TP UK VD YD YU ZR EU EZ UN QO'.split(' '),
);

/**
 * Bare codes accepted as a country word. Every other two-letter code is not one: `ID` (Apple ID), `NO` (a negation), `SE` (iPhone
 * SE), `AT` (inside AT&T), `AU` (the carrier au by KDDI), `IN` (`Windows IN MacOs`).
 *
 * Why: A3 section 5.3, plan section 3.5: only `US`, `UK` and `JP` occur as countries in the real names. `UK` is in
 * {@link EXTRA_COUNTRY_WORDS}; `US` and `JP` have their own rules (a whole capital word, `JP -` at the start).
 */
export const BARE_COUNTRY_CODES: readonly string[] = ['US', 'UK', 'JP'];

/**
 * Phrases that hold a country word without naming the service's country; they are blanked before countries are looked for.
 *
 * Why: A3 section 5.3: `CDMA YEMEN` is a tool, `SamsungTool.us` a web address, `Saudi Arabic` a language, `PlayStation Plus (UAE)`
 * a store region the next words repeat, `IN MacOs` an English word.
 */
export const COUNTRY_TRAPS: readonly RegExp[] = [
  /\bSamsungTool\.us\b/gi,
  /\bCDMA YEMEN\b/gi,
  /\bUK\b(?=raine)/g,
  /\bPlayStation Plus \(UAE\)/g,
  /\bIN MacOs\b/g,
  /\bSaudi Arabic\b/gi,
];

/**
 * A country word before `support(ed)` or after `not`/`non`/`no` says which devices work, not where the service is
 * (`China Supported`, `CHINA NOT SUPPORTED`, `Non-China`).
 *
 * Why: A3 section 5.3, names #31, #849, #1096, #1099.
 */
export const SUPPORT_TRAP =
  /\b(?:non-?|not\s+|no\s+)?(?:china|india|usa|us)\b\s*(?:not\s+)?support(?:ed)?\b|\bnon-china\b/gi;

/**
 * Words that mean no single country (`All Countries`, `Worldwide`, `Global`, `Europe`, `EMEA`).
 *
 * Why: A3 section 5.2: such a service has no country; a list of more than three countries is the same case.
 */
export const NO_SINGLE_COUNTRY = /\b(?:all countries?|world ?wide|global|europe|emea|all country)\b/i;
