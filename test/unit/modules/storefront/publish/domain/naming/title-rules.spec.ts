// Tests of the shop title rules (feature 31, plan sections 3.5 and 8.2): one case per rule R1-R14 with the before and after pairs
// of A3 section 3, the meaning words that must stay, idempotence, the cut and the router guard. `#n` is the line of the real name.
import { describe, expect, it } from 'bun:test';
import {
  balanceBrackets,
  bracketsBalanced,
  cleanTitle,
  cutTitle,
  groupText,
  isRouterCodeList,
  marketingTail,
  namingKind,
  titleCaseIfShouting,
} from '@src/modules/storefront/publish/domain/naming/title-rules';

describe('cleanTitle, rule by rule (A3 section 3)', () => {
  it('R1 drops invisible characters and turns a no-break space into a space (#79)', () => {
    expect(
      cleanTitle(
        'USA\u00A0 AT&T\u00A0 -\u00A0 iPhone | Generic\u00A0- Unlock Service [ Account2_Locked\u00A0 | IMEI2_Passcode_Locked ] 90% Success Rate \u2B50\uFE0F',
        'imei',
      ),
    ).toBe('USA AT&T - iPhone / Generic - Unlock Service [Account2 Locked / IMEI2 Passcode Locked]');
    expect(cleanTitle('Griffin-Unlocker\u200F Activation', 'server')).toBe('Griffin-Unlocker Activation');
  });

  it('R1 writes the look-alike letters of other scripts as Latin ones (#313, #727, #885)', () => {
    expect(cleanTitle('XJ WUX\u0130NJ\u0130 FCL ACT\u0130VAT\u0130ON (1 Month) Global', 'server')).toBe(
      'XJ Wuxinji FCL Activation (1 Month) Global',
    );
    expect(cleanTitle('MobileSea Tool Credit 10 Cred\u0131t', 'server')).toBe('MobileSea Tool Credit 10 Credit');
    expect(cleanTitle('Beeline L02H, \u041E! L02H', 'imei')).toBe('Beeline L02H, O! L02H');
  });

  it('R2 decodes HTML entities once (#106)', () => {
    expect(cleanTitle('Bahubali Power Tool Realme &amp; Xiaomi Frp &amp; Flash', 'server')).toBe(
      'Bahubali Power Tool Realme & Xiaomi FRP & Flash',
    );
  });

  it('R3 drops emoji and decoration and makes arrows plain (#33)', () => {
    expect(cleanTitle('\u26A1\uFE0F Register Unlimited Amrr iCloud Tools \u26A1\uFE0F', 'imei')).toBe(
      'Register Unlimited Amrr iCloud Tools',
    );
    expect(cleanTitle('Samsung \u2192 FRP Remove \u2705', 'imei')).toBe('Samsung - FRP Remove');
  });

  it('R4 drops Arabic script runs with the slash around them (#150), and an Arabic-only name gives an empty title (#1157)', () => {
    expect(
      cleanTitle(
        'Canva Pro 30 Days Account [ Student ] \u0636\u0645\u0627\u0646 \u0644\u0645\u062F\u0647 \u0634\u0647\u0631 / Waranty 30 Days',
        'server',
      ),
    ).toBe('Canva Pro 30 Days Account [Student] Warranty 30 Days');
    expect(cleanTitle('Mesallah Hardware Tool (\u0645\u0635\u0644\u062D) [1 PC 1 YEAR]', 'server')).toBe(
      'Mesallah Hardware Tool [1 PC 1 YEAR]',
    );
  });

  it('R5 unifies dashes, turns pipes into slashes, re-spaces brackets and turns braces into parentheses (#1, #429)', () => {
    expect(cleanTitle('360 TOOL Tojo360 Activation [ 12 Months - 1 Pc ]', 'server')).toBe(
      '360 TOOL Tojo360 Activation [12 Months - 1 PC]',
    );
    expect(cleanTitle('Google Pixel Carrier Unlock 100% |6|7|8|9|10 Series Supported', 'imei')).toBe(
      'Google Pixel Carrier Unlock 6/7/8/9/10 Series Supported',
    );
    expect(cleanTitle('CellTool { Samsungtool.us } Credits', 'server')).toBe('CellTool (Samsungtool.us) Credits');
    expect(cleanTitle('HONOR FRP Removal Service \u2013 Key', 'imei')).toBe('HONOR FRP Removal Service - Key');
    expect(cleanTitle('AT&T USA Active Line/Active Other/IMEI_issue', 'imei')).toBe(
      'AT&T USA Active Line/Active Other/IMEI issue',
    );
    expect(cleanTitle('(No_Longer_Active_On_AT&T_Account) Unlock', 'imei')).toBe(
      '(No Longer Active On AT&T Account) Unlock',
    );
    expect(cleanTitle('Tool __ Pro', 'server')).toBe('Tool __ Pro');
  });

  it('R6 fixes the typo list and the duration plurals (#52, #1081)', () => {
    expect(cleanTitle('Pro Arab-Unlock 1 Years Articles + Solutions', 'server')).toBe(
      'Pro Arab-Unlock 1 Year Articles + Solutions',
    );
    expect(cleanTitle('Verizon USA - iPhone Clean Unlock Not Elegible', 'imei')).toBe(
      'Verizon USA - iPhone Clean Unlock Not Eligible',
    );
    expect(cleanTitle('Borneo Schematic 3 Month Premimum', 'server')).toBe('Borneo Schematic 3 Months Premium');
  });

  it('R7 drops marketing (#63, #1148) and turns a trailing "All Models Supported" into "All Models"', () => {
    expect(cleanTitle('AT&T USA All models [ IMEI already processing in AT&T] 90% ratio', 'imei')).toBe(
      'AT&T USA All models [IMEI already processing in AT&T]',
    );
    expect(cleanTitle('Zen Auth Tool (Official Distributor)', 'server')).toBe('Zen Auth Tool');
    expect(cleanTitle('Honor Frp Key by Sn Only Auto Api Instant 100%', 'imei')).toBe('Honor FRP Key by SN Only');
    expect(cleanTitle('Sprint USA iPhone All Models Supported', 'imei')).toBe('Sprint USA iPhone All Models');
  });

  it('R7 never removes a marketing phrase right after "not" or "no"', () => {
    expect(cleanTitle('Samsung Unlock No Fast Service', 'imei')).toBe('Samsung Unlock No Fast Service');
    expect(cleanTitle('Samsung Unlock Fast Service', 'imei')).toBe('Samsung Unlock');
  });

  it('R8 drops delivery times on an IMEI service (#68) and keeps hours and days on a server service', () => {
    expect(
      cleanTitle(
        'AT&T USA iPhone 17 | 17 Air | 17 Pro | 17 Pro Max [Clean |Unpaid Bills] - 100% Unlock - 15-45 Days',
        'imei',
      ),
    ).toBe('AT&T USA iPhone 17 / 17 Air / 17 Pro / 17 Pro Max [Clean / Unpaid Bills]');
    expect(cleanTitle('HONOR FRP Removal Service (1\u201312 Hours | Max 24H)', 'imei')).toBe(
      'HONOR FRP Removal Service',
    );
    expect(cleanTitle('Share Cheetah Tool - 24 Hours', 'server')).toBe('Share Cheetah Tool - 24 Hours');
    expect(cleanTitle('Share Cheetah Tool - 24 Hours', 'imei')).toBe('Share Cheetah Tool');
  });

  it('names a remote and a file service by the server rules', () => {
    expect(namingKind('remote')).toBe('server');
    expect(namingKind('file')).toBe('server');
    expect(namingKind('imei')).toBe('imei');
    expect(cleanTitle('Share Cheetah Tool - 24 Hours', 'remote')).toBe('Share Cheetah Tool - 24 Hours');
    expect(cleanTitle('Share Cheetah Tool - 24 Hours', 'file')).toBe('Share Cheetah Tool - 24 Hours');
  });

  it('R9 writes face values as "$10" (#869) and drops "Any Qnt" (#234)', () => {
    expect(cleanTitle('Roblox 50 $ USA [4500 Robux]', 'server')).toBe('Roblox $50 USA [4500 Robux]');
    expect(cleanTitle('Playstation Store Gift Card Kuwait 10$', 'server')).toBe(
      'PlayStation Store Gift Card Kuwait $10',
    );
    expect(cleanTitle('Cheetah Tool Credit Any Qnt', 'server')).toBe('Cheetah Tool Credit');
  });

  it('R10 writes SHOUTING in Title Case and keeps acronyms (#1019)', () => {
    expect(cleanTitle('UK EE / T-MOBILE / ORANGE IPHONE, IPAD ALL MODELS (PREMIUM)', 'imei')).toBe(
      'UK EE / T-Mobile / Orange iPhone, iPad All Models (Premium)',
    );
    expect(titleCaseIfShouting('Mixed Case Stays As Written')).toBe('Mixed Case Stays As Written');
    expect(titleCaseIfShouting('UNLOCK BY IMEI FOR ZTE')).toBe('Unlock by IMEI for ZTE');
  });

  it('R11 writes the casing of the makers (#556)', () => {
    expect(cleanTitle('ICLOUD REMOVE ( FMI OFF ) IPhone Series 14', 'imei')).toBe(
      'iCloud REMOVE (FMI OFF) iPhone Series 14',
    );
    expect(cleanTitle('Itunes Gift Card Usa', 'server')).toBe('Itunes Gift Card USA');
    expect(cleanTitle('At&t iPhone 11 PRO MAX Unlock', 'imei')).toBe('AT&T iPhone 11 Pro Max Unlock');
    expect(cleanTitle('Hbo Max Account ( 1 Month )', 'server')).toBe('HBO Max Account (1 Month)');
    expect(cleanTitle('Us Gsm Default Policy - IPhone (All Model Support) Clean', 'imei')).toBe(
      'US GSM Default Policy - iPhone (All Model Support) Clean',
    );
  });

  it('R12 tidies the brackets and the separators and drops a repeated phrase (#352)', () => {
    expect(cleanTitle('FMI OFF - iPad (10th generation) - WiFi Model Only- [iPad13,18]', 'imei')).toBe(
      'FMI OFF - iPad (10th generation) - WiFi Model Only - [iPad13,18]',
    );
    expect(cleanTitle('Global Unlocker Pro Global Unlocker Pro Activation', 'server')).toBe(
      'Global Unlocker Pro Activation',
    );
    expect(cleanTitle('iPhone 11 11 Pro Unlock', 'imei')).toBe('iPhone 11 11 Pro Unlock');
  });

  it('R13 cuts a long title by whole trailing clauses (#60), never a router code list, never under 25 characters', () => {
    expect(cutTitle('AT&T USA Active Line/Active Other/IMEI_issue - iPhone & Generic All imeis Supported')).toBe(
      'AT&T USA Active Line/Active Other/IMEI_issue',
    );
    const router =
      'Unlock code by imei (#2) Router - Altel CPE P05/L02Hi, Beeline L02H/L02Hi/S23/SM25, Megafon M150-4/MR150-6, Tele2 OSH-150';
    expect(isRouterCodeList(router)).toBe(true);
    expect(cutTitle(router)).toBe(router);
    const noClause = 'A'.repeat(20) + ' - ' + 'word '.repeat(20).trim();
    expect(cutTitle(noClause)).toBe(noClause);
    expect(cutTitle('Short title [with a bracket]')).toBe('Short title [with a bracket]');
  });

  it.each([
    [
      'OPPO NETWORK UNLOCK Service All Country & Any Models NCK CODE [Not Support Single SIM Phone]',
      'OPPO NETWORK UNLOCK Service All Country & Any Models NCK CODE [Not Support Single SIM Phone]',
    ],
    [
      'US GSM/VZW N61/N56 - iPhone SE/6/6+/8/8+/X/XR/XS/11/12/13/13Pro/13Pro Max [PREMIUM] (7/7+ NO SUPPORTED)',
      'US GSM/VZW N61/N56 - iPhone SE/6/6+/8/8+/X/XR/XS/11/12/13/13Pro/13Pro Max [PREMIUM] (7/7+ NO SUPPORTED)',
    ],
    [
      'AT&T USA Unbarring Cleaning Service / Status Clean From Lost & Stolen - All Generic Models (Fraud Not Supported)',
      'AT&T USA Unbarring Cleaning Service / Status Clean From Lost & Stolen - All Generic Models (Fraud Not Supported)',
    ],
    [
      'Meow Tool Realme (Flashing + Reset FRP + Format) Auth Account INSTANT Account For You [RealMe Login Tool OTP (Realme Rcsm Flashing)] (No Refund any issue)',
      'Meow Tool Realme (Flashing + Reset FRP + Format) Auth Account INSTANT Account For You [RealMe Login Tool OTP (Realme Rcsm Flashing)] (No Refund any issue)',
    ],
    [
      'Verizon USA - iPhone Unlock All iPhones up to iPhone 17 Series Clean - Eligible Device Only - No Relock Warranty',
      'Verizon USA - iPhone Unlock All iPhones up to iPhone 17 Series Clean - Eligible Device Only - No Relock Warranty',
    ],
    [
      'Dragon FRP Tool Credit [OLD/EXISTING USER] Samsung Xiaomi / Vivo / Realme / Infinix ONLY Mtk',
      'Dragon FRP Tool Credit [OLD/EXISTING USER] Samsung Xiaomi / Vivo / Realme / Infinix ONLY Mtk',
    ],
    [
      'Windows 10/11 Professional 20 [1 Key - 20 PCs Activation] (ONLY 12 HOURS WARRANTY) [Instant Key Delivery Today]',
      'Windows 10/11 Professional 20 [1 Key - 20 PCs Activation] (ONLY 12 HOURS WARRANTY)',
    ],
  ])('R13 never cuts a clause that states a restriction or a refusal: %s', (title, cut) => {
    expect(cutTitle(title)).toBe(cut);
  });

  it('R13 drops a "Model" the cut leaves dangling, never "All Models" (#476)', () => {
    expect(
      cutTitle(
        'HFZ iWatch Ramdisk Bypass (Hello Screen-Passcode Bypass - Owner info) Model (SE-S4-S5)(Unlimited 3 Months)',
      ),
    ).toBe('HFZ iWatch Ramdisk Bypass (Hello Screen-Passcode Bypass - Owner info)');
    expect(cutTitle(`Unlock Service For Every Network On The Shop For iPhone All Model (${'x'.repeat(30)})`)).toBe(
      'Unlock Service For Every Network On The Shop For iPhone All Model',
    );
  });

  it('R13 runs the R7 tail once more after the cut (#1004)', () => {
    const clean = cleanTitle(
      'Tracfone/Straight Talk USA - Generic NCK All Models Supported  (Clean & ACTIVE +12 MONTHS)',
      'imei',
    );
    expect(cutTitle(clean)).toBe('TracFone/Straight Talk USA - Generic NCK All Models');
    expect(cleanTitle(cutTitle(clean), 'imei')).toBe(cutTitle(clean));
  });

  it('R14 trims the ends and gives an empty title when no Latin word is left (#1157)', () => {
    expect(
      cleanTitle(
        '\u0641\u0648\u0631\u0645\u0627\u062A \u062A\u0627\u0628 \u0645\u0646 10 \u0635\u0628\u0627\u062D\u0627',
        'imei',
      ),
    ).toBe('');
    expect(cleanTitle(' - Unlock Service / ', 'imei')).toBe('Unlock Service');
    expect(cleanTitle('\u2705 \u2705', 'imei')).toBe('');
  });
});

describe('the words that say what the buyer gets stay', () => {
  it.each([
    [
      'Xiaomi Mi Account Remove World Wide All Country Clean Only CHINA NOT SUPPORTED (FAST SERVICE)',
      'Xiaomi Mi Account Remove World Wide All Country Clean Only CHINA NOT SUPPORTED',
    ],
    [
      'Verizon USA - iPhone All Models ( Clean + Eligible Activated Only) WRONG CARRIER NO REFUND',
      'Verizon USA - iPhone All Models (Clean + Eligible Activated Only) WRONG CARRIER NO REFUND',
    ],
    ['FRPFILE Open Menu ( NOT FMI OFF ) - iPhone 12', 'FRPFILE Open Menu (NOT FMI OFF) - iPhone 12'],
    ['AT&T USA iPhone [Semi Premium |Unpaid bill supported]', 'AT&T USA iPhone [Semi Premium / Unpaid bill supported]'],
    ['AT&T USA - iPhone & Generic  / High Success', 'AT&T USA - iPhone & Generic / High Success'],
  ])('%s', (name, title) => {
    expect(cleanTitle(name, 'imei')).toBe(title);
  });
});

describe('idempotence', () => {
  it.each([
    'USA AT&T - iPhone / Generic - Unlock Service [Account2 Locked / IMEI2 Passcode Locked]',
    'Canva Pro 30 Days Account [Student] Warranty 30 Days',
    'UK EE / T-Mobile / Orange iPhone, iPad All Models (Premium)',
    'Roblox $50 USA [4500 Robux]',
    'iCloud REMOVE (FMI OFF) iPhone Series 14',
  ])('cleaning a clean title changes nothing: %s', (title) => {
    expect(cleanTitle(title, 'imei')).toBe(title);
  });

  it('keeps marketing words and delivery times when asked (the uniqueness ladder)', () => {
    expect(cleanTitle('Honor Frp Key by Sn Only Auto Api Instant 100%', 'imei', { keepMarketing: true })).toBe(
      'Honor FRP Key by SN Only Auto API Instant 100%',
    );
  });
});

describe('the helpers', () => {
  it('pairs the brackets', () => {
    expect(balanceBrackets('[Existing Users Only')).toBe('[Existing Users Only]');
    expect(balanceBrackets('Tool) (Pro [x)]')).toBe('Tool (Pro [x])');
    expect(bracketsBalanced('a (b) [c] {d}')).toBe(true);
    expect(bracketsBalanced('a (b [c]')).toBe(false);
  });

  it('removes only the "All Models Supported" tail', () => {
    expect(marketingTail('iPhone All Models Supported')).toBe('iPhone All Models');
    expect(marketingTail('CHINA NOT SUPPORTED')).toBe('CHINA NOT SUPPORTED');
  });

  it('reads a group as decoded text without emoji, invisible characters or Arabic script', () => {
    expect(groupText('AT&amp;T USA NETWORK UNLOCKED')).toBe('AT&T USA NETWORK UNLOCKED');
    expect(groupText('Cerberus Tool License ( Direct Source )\u2705')).toBe('Cerberus Tool License ( Direct Source )');
    expect(groupText('Griffin-Unlocker\u200F')).toBe('Griffin-Unlocker');
    expect(groupText('Fix Error Apple ID \u0644\u0627 \u064A\u0639\u0645\u0644')).toBe('Fix Error Apple ID');
  });
});
