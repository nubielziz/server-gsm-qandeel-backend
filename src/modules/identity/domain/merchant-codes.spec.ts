// Unit tests of the generated merchant names: shape, alphabet and the way the random source is used.
import { describe, expect, it } from 'bun:test';
import { REFERRAL_PREFIX, referralCodeFor, usernameFor } from './merchant-codes';

/** A random source that walks a fixed list, wrapping around, so the output is predictable. */
function walker(values: number[]): (max: number) => number {
  let next = 0;
  return (max) => values[next++ % values.length]! % max;
}

describe('referralCodeFor', () => {
  it('starts with GSM and has six characters from the unambiguous alphabet', () => {
    const code = referralCodeFor(walker([0, 1, 2, 3, 4, 5]));
    expect(code).toBe(`${REFERRAL_PREFIX}ABCDEF`);
    for (let i = 0; i < 200; i++)
      expect(referralCodeFor((max) => Math.floor(Math.random() * max))).toMatch(/^GSM[A-HJ-NP-Z2-9]{6}$/);
  });

  it('never uses the confusing 0, 1, O or I', () => {
    const everything = referralCodeFor(walker(Array.from({ length: 32 }, (_, i) => i)));
    expect(everything).not.toMatch(/[01OI]/);
  });
});

describe('usernameFor', () => {
  it('keeps the letters and digits of the local part, lower-cased, and adds five digits', () => {
    expect(usernameFor('Ali.Hassan+gsm@Example.com', walker([4, 8, 2, 1, 3]))).toBe('alihassangsm48213');
  });

  it('cuts a long local part and falls back to "merchant" when nothing usable is left', () => {
    expect(usernameFor('averyveryverylongaddressname@example.com', walker([0]))).toBe('averyveryverylon00000');
    expect(usernameFor('..--@example.com', walker([7]))).toBe('merchant77777');
  });
});
