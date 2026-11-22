// Unit tests of the API key hint and of the binding of a saved key to where it is sent (decision 051).
import { describe, expect, it } from 'bun:test';
import { KEY_HINT_MASK, apiKeyHintOf, keyBindingChanged } from '@src/modules/suppliers/domain/supplier-key';

describe('apiKeyHintOf', () => {
  it('shows the mask and the last 2 characters of a key of 16 or more characters, the mask alone for a shorter one', () => {
    expect(apiKeyHintOf('0123456789abcdef')).toBe('••••ef');
    expect(apiKeyHintOf('fake-supplier-key-001')).toBe('••••01');
    expect(apiKeyHintOf('0123456789abcde')).toBe(KEY_HINT_MASK);
    expect(apiKeyHintOf('x')).toBe(KEY_HINT_MASK);
    // The last 2 are code points: an emoji at the end is kept whole.
    expect(apiKeyHintOf('0123456789abcd\u{1F600}\u{1F601}')).toBe('••••\u{1F600}\u{1F601}');
    expect(KEY_HINT_MASK).toBe('\u2022\u2022\u2022\u2022');
  });
});

describe('keyBindingChanged', () => {
  const saved = { baseUrl: 'https://supplier.example/api', username: 'gsm-supply', driver: 'dhru' };

  it('binds a saved key to its origin, username and driver', () => {
    expect(keyBindingChanged(saved, { baseUrl: 'https://supplier.example/other/path' })).toBe(false);
    expect(keyBindingChanged(saved, { baseUrl: 'https://supplier.example' })).toBe(false);
    expect(keyBindingChanged(saved, { baseUrl: 'https://other.example/api' })).toBe(true);
    expect(keyBindingChanged(saved, { baseUrl: 'https://supplier.example:8443/api' })).toBe(true);
    expect(keyBindingChanged(saved, { baseUrl: 'http://supplier.example/api' })).toBe(true);
    expect(keyBindingChanged(saved, { username: 'gsm-supply' })).toBe(false);
    expect(keyBindingChanged(saved, { username: 'someone-else' })).toBe(true);
    expect(keyBindingChanged(saved, { driver: 'dhru' })).toBe(false);
    expect(keyBindingChanged(saved, { driver: 'rest' })).toBe(true);
    expect(keyBindingChanged(saved, {})).toBe(false);
  });

  it('counts a stored address that does not parse as another origin', () => {
    expect(keyBindingChanged({ ...saved, baseUrl: 'not a url' }, { baseUrl: 'https://supplier.example' })).toBe(true);
  });
});
