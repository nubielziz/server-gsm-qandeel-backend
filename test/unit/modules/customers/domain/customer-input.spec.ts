// Unit tests of the input rules of the admin customer routes: how a name, email and phone are cleaned.
import { describe, expect, it } from 'bun:test';
import { cleanName, cleanPhone, greetingName, normaliseEmail } from '@src/modules/customers/domain/customer-input';

describe('cleanName', () => {
  it('trims and collapses every run of white space to one space', () => {
    expect(cleanName('  Daniel   Whitmore ')).toBe('Daniel Whitmore');
    expect(cleanName('Daniel\t\nWhitmore')).toBe('Daniel Whitmore');
    expect(cleanName('   ')).toBe('');
  });
});

describe('normaliseEmail', () => {
  it('trims and lower-cases, the form every lookup and the blocklist hash use', () => {
    expect(normaliseEmail(' Daniel.Whitmore@Example.COM ')).toBe('daniel.whitmore@example.com');
  });
});

describe('cleanPhone', () => {
  it('trims a phone', () => {
    expect(cleanPhone(' +447700900123 ')).toBe('+447700900123');
  });
});

describe('greetingName', () => {
  it('greets a guest who gave no name as "there", and a person by the name tidied of its edges', () => {
    expect(greetingName('')).toBe('there');
    expect(greetingName('  ')).toBe('there');
    expect(greetingName(' Sam ')).toBe('Sam');
  });
});
