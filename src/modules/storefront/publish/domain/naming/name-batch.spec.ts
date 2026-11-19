// Tests of the batch naming (feature 31, plan sections 3.5 and 8.2): the cut guard against the batch and the listings' titles
// (#476 beside the listed #473-#475), the uniqueness ladder, `title_taken`, `duplicate_name`, a fixed title, and facts that never
// depend on the batch. `#n` is the line of the real name.
import { describe, expect, it } from 'bun:test';
import { type BatchInput, type NamedService, nameAll } from './name-batch';

const HFZ_GROUP = 'HFZ Ramdaik iWatch S4-5-SE1';
const hfz = (plan: string): BatchInput => ({
  name: `HFZ iWatch Ramdisk Bypass (Hello Screen-Passcode Bypass -Owner info )Model (SE-S4-S5)( ${plan} )\u2705`,
  type: 'imei',
  group: HFZ_GROUP,
});
const HFZ_FULL = 'HFZ iWatch Ramdisk Bypass (Hello Screen-Passcode Bypass - Owner info) Model (SE-S4-S5)';
const HFZ_CUT = 'HFZ iWatch Ramdisk Bypass (Hello Screen-Passcode Bypass - Owner info)';
const LISTED = [`${HFZ_FULL}(Unlimited 1 Month)`, `${HFZ_FULL}(Unlimited 1Week)`, `${HFZ_FULL}(Unlimited 1 Year)`];

describe('nameAll: the cut guard', () => {
  it('cuts a long title published alone with no listing (#476)', () => {
    const [row] = nameAll([hfz('Unlimitid 3 Month')]);
    expect(row?.title).toBe(HFZ_CUT);
  });

  it('keeps the full title of #476 when #473-#475 are listings already: the cut would make it their twin', () => {
    const [row] = nameAll([hfz('Unlimitid 3 Month')], { listingTitles: LISTED });
    expect(row?.title).toBe(`${HFZ_FULL}(Unlimited 3 Months)`);
    expect(row?.flags).toEqual(['title_long']);
  });

  it('keeps the full title of a row whose uncut title a listing holds, and flags it as taken (#71)', () => {
    const name =
      'AT&T USA iPhones All Models UNLOCK - Cant locate IMEI in AT&T database & We cant locate it in our database of devices sold by AT&T';
    const row = { name, type: 'imei' as const, group: 'AT&amp;T USA NETWORK UNLOCKED SIM NOT SUPPORTED' };
    expect(nameAll([row])[0]?.title).toBe('AT&T USA iPhones All Models UNLOCK');
    const [listed] = nameAll([row], { listingTitles: [name] });
    expect(listed?.title).toBe(name);
    expect(listed?.flags).toEqual(['title_long', 'title_taken']);
  });

  it('keeps the full titles of variants named in one batch (#473-#476)', () => {
    const rows = nameAll([
      hfz('Unlimitid 1 Month  '),
      hfz('Unlimitid 1Week'),
      hfz('Unlimitid 1 Year   '),
      hfz('Unlimitid 3 Month'),
    ]);
    expect(rows.map((row) => row.title)).toEqual([...LISTED, `${HFZ_FULL}(Unlimited 3 Months)`]);
    expect(new Set(rows.map((row) => row.slugBase)).size).toBe(4);
  });
});

describe('nameAll: the uniqueness ladder and the twins', () => {
  it('puts the marketing words back where two different names would share a slug base', () => {
    const rows = nameAll([
      { name: 'Samsung Remote Unlock 100% Success', type: 'imei', group: 'Samsung' },
      { name: 'Samsung Remote Unlock Fast Service', type: 'imei', group: 'Samsung' },
    ]);
    expect(rows.map((row) => row.title)).toEqual([
      'Samsung Remote Unlock 100% Success',
      'Samsung Remote Unlock Fast Service',
    ]);
    expect(rows.every((row) => row.flags.includes('marketing_kept'))).toBe(true);
    expect(rows.some((row) => row.flags.includes('title_taken'))).toBe(false);
  });

  it('flags a title a listing holds already, compared without case and repeated spaces', () => {
    const [row] = nameAll([{ name: 'Samsung FRP Remove', type: 'imei', group: 'Samsung' }], {
      listingTitles: ['samsung  frp remove'],
    });
    expect(row?.flags).toContain('title_taken');
  });

  it('flags both rows of one supplier name as duplicates, not as taken titles', () => {
    const name = 'Playstation Store Gift Card Kuwait 10$';
    const rows = nameAll([
      { name, type: 'server', group: 'PLAYSTATION CARD [ KUWAIT STORE ]' },
      { name, type: 'server', group: 'Playstation Store (Kuwait)' },
    ]);
    expect(rows.map((row) => row.title)).toEqual([
      'PlayStation Store Gift Card Kuwait $10',
      'PlayStation Store Gift Card Kuwait $10',
    ]);
    expect(rows.map((row) => row.flags.includes('duplicate_name'))).toEqual([true, true]);
    expect(rows.some((row) => row.flags.includes('title_taken'))).toBe(false);
    expect(rows.map((row) => row.slugBase)).toEqual([
      'playstation-store-gift-card-kuwait-10-usd',
      'playstation-store-gift-card-kuwait-10-usd',
    ]);
  });

  it('flags two different names that still end as one title', () => {
    const rows = nameAll([
      { name: 'Unlock Service \u2705', type: 'imei', group: 'x' },
      { name: 'Unlock  Service', type: 'imei', group: 'x' },
    ]);
    expect(rows.map((row) => row.title)).toEqual(['Unlock Service', 'Unlock Service']);
    expect(rows.every((row) => row.flags.includes('title_taken'))).toBe(true);
  });
});

describe('nameAll: rows and facts', () => {
  it('keeps a fixed title and still counts it in the uniqueness checks', () => {
    const rows = nameAll([{ ...hfz('Unlimitid 1 Month'), fixedTitle: HFZ_CUT }, hfz('Unlimitid 3 Month')]);
    expect(rows[0]?.title).toBe(HFZ_CUT);
    expect(rows[1]?.title).toBe(`${HFZ_FULL}(Unlimited 3 Months)`);
    expect(rows[0]?.brand).toBe('Apple');
  });

  it('gives the rows in the order of the input with the same facts as each row named alone', () => {
    const input: BatchInput[] = [
      { name: 'US AT&T Clean Unlock', type: 'imei', group: 'AT&amp;T USA NETWORK UNLOCKED' },
      { name: 'Chimera Tool 12 Months', type: 'server', group: 'Chimera Tool - Direct Source Services' },
      { name: 'Roblox 50 $ USA [4500 Robux]', type: 'server', group: 'ROBLOX USA' },
    ];
    const together = nameAll(input);
    const facts = (rows: readonly NamedService[]) =>
      rows.map(({ brand, carrier, country }) => ({ brand, carrier, country }));
    expect(facts(together)).toEqual(facts(input.flatMap((row) => nameAll([row]))));
    expect(together.map((row) => row.brand)).toEqual(['', 'Chimera Tool', 'Roblox']);
    expect(together[0]).toMatchObject({
      title: 'US AT&T Clean Unlock',
      slugBase: 'us-att-clean-unlock',
      carrier: 'AT&T',
    });
    expect(together[0]?.flags).toEqual(['no_brand']);
  });

  it('gives an Arabic-only name an empty title and slug base', () => {
    const [row] = nameAll([{ name: '\u0641\u0648\u0631\u0645\u0627\u062A', type: 'imei', group: '' }]);
    expect(row).toMatchObject({ title: '', slugBase: '', flags: ['no_brand'] });
  });

  it('gives a server or remote service of the Imported category no brand, and flags the gap', () => {
    const [server, remote] = nameAll([
      { name: 'Mystery Service 1 Month', type: 'server', group: 'Imported' },
      { name: 'Mystery Session 2 Hours', type: 'remote', group: 'Imported' },
    ]);
    expect(server).toMatchObject({ brand: '', brandKind: null, flags: ['no_brand'] });
    expect(remote).toMatchObject({ brand: '', brandKind: null, flags: ['no_brand'] });
  });

  it('names nothing for an empty batch', () => {
    expect(nameAll([])).toEqual([]);
  });
});
