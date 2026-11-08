// Unit tests of the reply template shortcut rules (RESOLUTIONS b2c-9).
import { describe, expect, it } from 'bun:test';
import { isValidShortcut, shortcutToStored, shortcutToWire } from './template-rules';

describe('isValidShortcut', () => {
  it('accepts none and a slash word, and refuses the rest', () => {
    expect(isValidShortcut('')).toBe(true);
    expect(isValidShortcut('/refund')).toBe(true);
    expect(isValidShortcut('/a')).toBe(true);
    expect(isValidShortcut('refund')).toBe(false);
    expect(isValidShortcut('/')).toBe(false);
    expect(isValidShortcut('/two words')).toBe(false);
    expect(isValidShortcut(`/${'x'.repeat(40)}`)).toBe(false);
  });
});

describe('the stored shortcut', () => {
  it('stores an empty or blank shortcut as null, trims the rest and reads null back as an empty string', () => {
    expect(shortcutToStored('')).toBeNull();
    expect(shortcutToStored('   ')).toBeNull();
    expect(shortcutToStored('  /refund ')).toBe('/refund');
    expect(shortcutToWire(null)).toBe('');
    expect(shortcutToWire('/refund')).toBe('/refund');
  });
});
