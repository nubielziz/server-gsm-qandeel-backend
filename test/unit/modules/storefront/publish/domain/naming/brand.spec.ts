// Tests of the brand detection (feature 31, plan sections 3.5 and 8.2): the three kinds, the order of the rules and every trap of
// A3 section 4. Titles are given as the title rules leave them; groups as `groupText` gives them. `#n` is the line of the real name.
import { describe, expect, it } from 'bun:test';
import { detectBrand, toolFromGroup } from '@src/modules/storefront/publish/domain/naming/brand';

describe('detectBrand: the traps of A3 section 4', () => {
  it('reads "Nothing Tool" as an iPhone tool, not the Nothing phone (#756)', () => {
    expect(detectBrand('A12 A13 Passcode [With Signal Nothing Tool]', 'Nothing Tool A12 - 13', 'imei')).toEqual({
      name: 'Apple',
      kind: 'device',
    });
    expect(detectBrand('Nothing Phone 2 FRP Remove', 'Android FRP', 'imei')).toEqual({
      name: 'Nothing',
      kind: 'device',
    });
  });

  it('reads "Kyocera Phone" as Kyocera, not Apple (#660)', () => {
    expect(
      detectBrand(
        'Japan Aquos Kyocera Phone (All Model Supported) [Clean/Unpaid]',
        'Japan NETWORK UNLOCKED SIM NOT SUPPORTED',
        'imei',
      ),
    ).toEqual({ name: 'Kyocera', kind: 'device' });
  });

  it('reads an Apple ID account that names Microsoft Mail as Apple: the earliest app wins (#46)', () => {
    expect(
      detectBrand(
        'Apple ID USA Without 2FA (AppStore Only)(Microsoft Mail Gmail) Old iOS 12',
        'Apple Accounts',
        'server',
      ),
    ).toEqual({ name: 'Apple', kind: 'app' });
  });

  it('reads "Dhru Fusion - Telegram" as Dhru Fusion (#122)', () => {
    expect(detectBrand('Dhru Fusion - Telegram Messenger Notification', 'Build Your Server (DHRU)', 'server')).toEqual({
      name: 'Dhru Fusion',
      kind: 'app',
    });
  });

  it('reads Knoxwizard as a tool, never as Samsung (#693)', () => {
    expect(detectBrand('Knoxwizard.com Activation (1 pc - 12 Months)', 'Knoxwizard Activation', 'server')).toEqual({
      name: 'Knoxwizard',
      kind: 'tool',
    });
    expect(detectBrand('Knoxwizard FRP Remove', 'FRP Services', 'imei')).toBeNull();
    expect(detectBrand('Knox Guard Remove', 'FRP Services', 'imei')).toEqual({ name: 'Samsung', kind: 'device' });
  });

  it('lets the group name the tool of a server service whose name holds a device word (Pixel Pro Tool)', () => {
    expect(detectBrand('Pixel Pro Tool 1 Year Activation', 'Pixel Pro Tool', 'server')).toEqual({
      name: 'Pixel Pro Tool',
      kind: 'tool',
    });
  });

  it('gives no brand to an IMEI name that names several makers', () => {
    expect(detectBrand('Eir / Meteor Samsung, Motorola, Huawei Unlock', 'Ireland Networks', 'imei')).toBeNull();
    expect(detectBrand('EID Pro Check (Apple/Samsung/Google)', 'Check Services', 'imei')).toBeNull();
  });

  it('keeps Apple for an iPhone name that also holds one other maker word', () => {
    expect(detectBrand('iPhone Unlock with LG Tool', 'Unlock', 'imei')).toEqual({ name: 'Apple', kind: 'device' });
  });
});

describe('detectBrand: the order of the rules', () => {
  it('reads the device maker from the group when the name names none', () => {
    expect(detectBrand('Remove Account [Sudan] Clean IMEI Only', 'Xiaomi Remove Account', 'imei')).toEqual({
      name: 'Xiaomi',
      kind: 'device',
    });
  });

  it('reads a server tool from the frozen list when the group is a shop-like group', () => {
    expect(detectBrand('Share Octoplus FRP Box - 1 Hour', 'Share Box & Tools Software', 'server')).toEqual({
      name: 'Octoplus',
      kind: 'tool',
    });
  });

  it('reads the head of the name when the group is a feature list', () => {
    expect(detectBrand('Android Auth Tool AAT - 3 Months', 'Xiaomi Auth Flash/FRP/FDL/MTKV5/V6/EFS', 'server')).toEqual(
      { name: 'Android Auth Tool AAT', kind: 'tool' },
    );
  });

  it('gives an app before a tool and a tool before a device on a server service', () => {
    expect(detectBrand('iTunes Gift Card $10 USA', 'iTunes USA', 'server')).toEqual({ name: 'iTunes', kind: 'app' });
    expect(detectBrand('Samsung FRP Credits', 'Chimera Tool - Direct Source Services', 'server')).toEqual({
      name: 'Chimera Tool',
      kind: 'tool',
    });
  });

  it('gives no brand when nothing matches: the rules never guess', () => {
    expect(detectBrand('IMEI Blacklist Check', 'Check Services', 'imei')).toBeNull();
  });

  it('never takes the name of the Imported category for a tool: a server or remote service reads its brand from its own name', () => {
    expect(detectBrand('Mystery Service 1 Month', 'Imported', 'server')).toBeNull();
    expect(detectBrand('Chimera Tool 1 Year', 'Imported', 'server')).toEqual({ name: 'Chimera Tool', kind: 'tool' });
    expect(detectBrand('Samsung Knox Guard Remove', 'Imported', 'server')).toEqual({ name: 'Samsung', kind: 'device' });
  });
});

describe('toolFromGroup', () => {
  it.each([
    ['Chimera Tool - Direct Source Services', 'Chimera Tool'],
    ['Octopus, Octoplus ( Box & Dongle )', 'Octoplus'],
    ['Cerberus Tool License ( Direct Source )', 'Cerberus'],
    ['CHEETAH TOOL', 'Cheetah Tool'],
    ['Zen Auth Tool (Official Distributor)', 'Zen Auth Tool'],
    ['CDMA YEMEN Team - Tool', 'CDMA Yemen Tool'],
  ])('%s gives %s', (group, tool) => {
    expect(toolFromGroup(group)).toBe(tool);
  });
});
