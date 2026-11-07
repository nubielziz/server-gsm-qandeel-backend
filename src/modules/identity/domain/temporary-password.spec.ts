// Unit tests of the temporary password generator: alphabet, length, character classes and the policy retry.
import { describe, expect, it } from 'bun:test';
import { checkPasswordPolicy } from './password-policy';
import { TEMPORARY_PASSWORD_LENGTH, generateTemporaryPassword, temporaryPasswordFor } from './temporary-password';

/** A deterministic "random" source: a linear congruential generator. */
function seeded(seed: number): (max: number) => number {
  let state = seed;
  return (max) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % max;
  };
}

describe('generateTemporaryPassword', () => {
  it('has the fixed length, no look-alike characters, and every character class', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const password = generateTemporaryPassword(seeded(seed));
      expect(password).toHaveLength(TEMPORARY_PASSWORD_LENGTH);
      expect(password).not.toMatch(/[IlO01]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/\d/);
      expect(checkPasswordPolicy(password)).toBeUndefined();
    }
  });

  it('differs from one random source to another', () => {
    expect(generateTemporaryPassword(seeded(1))).not.toBe(generateTemporaryPassword(seeded(2)));
  });
});

describe('temporaryPasswordFor', () => {
  it('returns a password that passes the policy for the account', () => {
    const password = temporaryPasswordFor(seeded(7), { email: 'nadia.hamdan@gsm.example', name: 'Nadia Hamdan' });
    expect(checkPasswordPolicy(password, { email: 'nadia.hamdan@gsm.example', name: 'Nadia Hamdan' })).toBeUndefined();
  });

  it('gives up with an error when the random source is stuck on a failing password', () => {
    // Always picking 0 gives "A" + "a" + "2" + the first alphabet character repeated: fewer than 5 different characters.
    expect(() => temporaryPasswordFor(() => 0, { email: 'x@y.example', name: 'X Y' })).toThrow(/policy/);
  });
});
