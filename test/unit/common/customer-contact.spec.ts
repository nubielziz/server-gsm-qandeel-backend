// Unit tests of the account contact mask (decisions 047 and 064): equal to the console's mask wherever the console masks, stricter where
// it would not. The same mask serves every account, whatever its rank.
import { describe, expect, it } from 'bun:test';
import { customerEmailIn, customerNameForStaff, maskCustomerEmail } from '@src/common/customer-contact';

/** The console's own `maskEmail` (src/lib/format/text.ts of the console). */
const consoleMask = (email: string): string => email.replace(/^(.{2}).*(@.*)$/, '$1•••$2');

const CORPUS = [
  'jane@example.com',
  'ab@x.io',
  'a.b+c@sub.example.co.uk',
  'x@y@z.com',
  'Ja@EXAMPLE.com',
  'ja•••@example.com',
];

describe('maskCustomerEmail', () => {
  it('masks exactly like the console wherever the console masks', () => {
    for (const email of CORPUS) expect(maskCustomerEmail(email), email).toBe(consoleMask(email));
    expect(maskCustomerEmail('jane@example.com')).toBe('ja•••@example.com');
  });

  it("is unchanged by the console's second pass", () => {
    for (const email of CORPUS) expect(consoleMask(maskCustomerEmail(email)), email).toBe(maskCustomerEmail(email));
  });

  it('hides what the console would leave whole', () => {
    expect(maskCustomerEmail('a@x.com')).toBe('•••@x.com');
    expect(maskCustomerEmail('no-at')).toBe('•••');
    expect(maskCustomerEmail('@x.com')).toBe('•••@x.com');
    expect(maskCustomerEmail('')).toBe('');
    // The console shows these in full, and its second pass over the server's text gives five bullets (the handoff names it).
    expect(consoleMask('•••@x.com')).toBe('•••••@x.com');
    expect(consoleMask('a@x.com')).toBe('a@x.com');
    expect(consoleMask('no-at')).toBe('no-at');
  });
});

describe('customerEmailIn and customerNameForStaff', () => {
  it('gives the address of an account of any rank in full or masked, by what the caller may see', () => {
    expect(customerEmailIn('full', 'jane@example.com')).toBe('jane@example.com');
    expect(customerEmailIn('masked', 'jane@example.com')).toBe('ja•••@example.com');
    expect(customerEmailIn('masked', '')).toBe('');
  });

  it('labels an account by the name, and by the masked address when the name is empty', () => {
    expect(customerNameForStaff('Jane Doe', 'jane@example.com')).toBe('Jane Doe');
    expect(customerNameForStaff('', 'jane@example.com')).toBe('ja•••@example.com');
    expect(customerNameForStaff('', 'a@x.com')).toBe('•••@x.com');
  });
});
