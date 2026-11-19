// Spelling data of the shop title rules (feature 31, plan section 3.5; A3 section 3, rules R6 and R11): the suppliers' typos with
// their fixes, the duration plurals, and the canonical casing of brands, carriers and Apple model words. Pure data.

/** A text replacement: the pattern and what each match becomes (a string with `$n` groups, or a function of the match). */
export type Replacement = readonly [RegExp, string | ((match: string, ...groups: string[]) => string)];

/**
 * The typo list and the duration plurals of rule R6 (`Premimum` gives `Premium`, `1 Years` gives `1 Year`, `3 Month` gives
 * `3 Months`), applied in this order.
 *
 * Why: A3 section 2 counted the suppliers' typos in the 1157 real names; a shop title is read by visitors, so the typo goes
 * (the service keeps its supplier name). The plural entries run last, after the words are spelled right.
 */
export const TYPO_FIXES: readonly Replacement[] = [
  [/\bPremimum\b/gi, 'Premium'],
  [/\bGenric\b/gi, 'Generic'],
  [/\bElegible\b/gi, 'Eligible'],
  [/\bEligiblity\b/gi, 'Eligibility'],
  [/\bActiavtion\b|\bActivaion\b|\bActiviation\b/gi, 'Activation'],
  [/\bWaranty\b/gi, 'Warranty'],
  [/\bUnlimitid\b/gi, 'Unlimited'],
  [/\bFacotry\b/gi, 'Factory'],
  [/\bSuppoprt\b/gi, 'Support'],
  [/\bDeivce\b/gi, 'Device'],
  [/\bMircale\b/gi, 'Miracle'],
  [/\bOFFIAL\b/g, 'OFFICIAL'],
  [/\bXioami\b/gi, 'Xiaomi'],
  [/\bExiting\b/gi, 'Existing'],
  [/\bEXISITNG\b/gi, 'EXISTING'],
  [/\bRenewel\b/gi, 'Renewal'],
  [/\bSliver\b/g, 'Silver'],
  [/\bKodoo\b/gi, 'Koodo'],
  [/\bModles\b|\bMODLES\b/g, 'Models'],
  [/\bInsant\b/gi, 'Instant'],
  [/\bDegits\b/gi, 'Digits'],
  [/\bect\b\.?/gi, 'etc.'],
  [/\bLife Time\b|\bLifeTime\b/gi, 'Lifetime'],
  [/\b1\s*(Years|Months|Weeks|Days)\b/gi, (_match, unit = '') => `1 ${unit.slice(0, -1)}`],
  [
    /\b(\d+)\s*(Year|Month|Week|Day)\b(?!s)/gi,
    (match, count = '') => {
      if (count === '1') return match;
      const word = match.replace(/^\d+\s*/, '');
      // A word in capitals takes a capital S (`2 YEAR` gives `2 YEARS`), so the SHOUTING rule still sees one word.
      return `${count} ${word}${word === word.toUpperCase() ? 'S' : 's'}`;
    },
  ],
  [/\b(\d+)\s*yrs?\b/gi, (_match, count = '') => `${count} Year${count === '1' ? '' : 's'}`],
];

/**
 * The canonical spelling of brands, carriers, Apple model words and common acronyms (rule R11: `IPhone` gives `iPhone`, `ICLOUD`
 * gives `iCloud`, `11 PRO MAX` gives `11 Pro Max`, `Frp` gives `FRP`), applied in this order after the SHOUTING rule.
 *
 * Why: A3 section 3: the rule runs after R10 so `ICLOUD` is not title-cased to `Icloud` first; the shop shows the makers' own
 * spelling.
 */
export const CASING_FIXES: readonly Replacement[] = [
  [
    /\biPHONES?\b|\bIphones?\b|\bIPhones?\b|\bIPHONES?\b/g,
    (match) => (match.toLowerCase().endsWith('s') ? 'iPhones' : 'iPhone'),
  ],
  [/\biPADS?\b|\bIpads?\b|\bIPads?\b|\bIPADS?\b/g, (match) => (match.toLowerCase().endsWith('s') ? 'iPads' : 'iPad')],
  [/\bICLOUD\b|\bIcloud\b|\bICloud\b/g, 'iCloud'],
  [/\bITunes\b|\bITUNES\b/g, 'iTunes'],
  [/\biWATCH\b|\bIwatch\b|\bIWATCH\b/g, 'iWatch'],
  [/\bMACBOOK\b|\bMacbook\b/g, 'MacBook'],
  [/\bPlaystation\b|\bPLAYSTATION\b/g, 'PlayStation'],
  [/\bYoutube\b/g, 'YouTube'],
  [/\bWhatsapp\b/g, 'WhatsApp'],
  [/\bPubg\b/g, 'PUBG'],
  [/\bIOS\b/g, 'iOS'],
  [/\bAt&t\b|\bAT&t\b|\bat&t\b/g, 'AT&T'],
  [/\bT-mobile\b|\bT-MOBILE\b/g, 'T-Mobile'],
  [/\bTracfone\b|\bTRACFONE\b/g, 'TracFone'],
  [/\bNtt\b/g, 'NTT'],
  [/\bHbo\b/g, 'HBO'],
  [/\bUs Gsm\b/g, 'US GSM'],
  [/\bUsa\b|\bU\.S\.A\b/g, 'USA'],
  [/\bSASKTEL\b|\bSasktel\b|\bSaskatel\b/g, 'SaskTel'],
  [/\bMETROPCS\b|\bMetropcs\b|\bMetroPcs\b/g, 'MetroPCS'],
  [/\bFrp\b/g, 'FRP'],
  [/\bImei\b/g, 'IMEI'],
  [/\bMdm\b/g, 'MDM'],
  [/\bNck\b/g, 'NCK'],
  [/\bFmi\b/g, 'FMI'],
  [/\bOtp\b/g, 'OTP'],
  [/\bUsb\b/g, 'USB'],
  [/\bSn\b/g, 'SN'],
  [/\bPc\b/g, 'PC'],
  [/\bPcs\b/g, 'PCs'],
  [/\bAuto Api\b/gi, 'Auto API'],
  // Apple model words after `iPhone` or `iPad` and a model number, or after a number: `11 PRO MAX` gives `11 Pro Max`.
  [
    /(?<=\b(?:iPhone|iPad|iPhones|iPads)\b[^[(]*?\d[A-Za-z]*\s)(PRO|MAX|MINI|PLUS|AIR)\b/g,
    (match) => match.charAt(0) + match.slice(1).toLowerCase(),
  ],
  [/(?<=\b\d+\s)(PRO|MAX|MINI|PLUS)\b/g, (match) => match.charAt(0) + match.slice(1).toLowerCase()],
  [/(?<=\b\d+\s(?:Pro|Mini|Plus)\s)(MAX)\b/g, 'Max'],
];

/**
 * Words the SHOUTING rule (R10) never title-cases when written in capitals: acronyms, codes, chips and short brand names.
 *
 * Why: A3 section 3, R10: `UK EE / T-MOBILE` becomes `UK EE / T-Mobile`, never `Uk Ee`; `IMEI`, `FRP`, `A12` keep their spelling.
 */
export const PROTECTED_WORDS: ReadonlySet<string> = new Set(
  'IMEI IMEI2 SN FMI MDM FRP USA UK UAE KSA US NZ EMEA AT&T T-Mobile NCK UMT EFT DFT TFM TSM RTC CDMA HFZ API PC PCS OTP QC MTK EFS FDL EDL AUTH UAT EE O2 VIP IDM LG ZTE KG CM2 BB5 CPU LTE SE XS XR DT MAX SIM GSM ID OS AIO TV DHRU SAR UC XRY T2 M1 M2 M3 M4 M5 A12 A13 A5 A6 A7 A8 A9 A11 E-GSM CP SK MG LU'.split(
    ' ',
  ),
);

/**
 * Small words the SHOUTING rule writes in lower case inside a title (`UNLOCK BY IMEI` gives `Unlock by IMEI`).
 *
 * Why: A3 section 3, R10: English title case.
 */
export const SMALL_WORDS: ReadonlySet<string> = new Set(
  'by for to of and or on in with without the a an at from'.split(' '),
);

/**
 * Three-letter words in capitals that the SHOUTING rule still title-cases (they are words, not acronyms: `NEW`, `PRO`, `ALL`).
 *
 * Why: A3 section 3, R10: a capital word of three letters or less is kept as an acronym (`SPD`, `HD`) unless it is one of these.
 */
export const COMMON_SHORT_WORDS: ReadonlySet<string> = new Set(
  'new old pro all any for the and not key box max tab top use one add get out off low sim day fix win mac web lte vip'.split(
    ' ',
  ),
);
