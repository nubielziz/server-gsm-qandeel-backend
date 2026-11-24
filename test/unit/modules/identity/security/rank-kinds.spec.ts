// Unit tests of the rank kind lookup of the session core (decision 064): installed once, reads through, and keeps the one retail rank.
import { describe, expect, it } from 'bun:test';
import { type RankKindLookup, RankKinds } from '@src/modules/identity/security/rank-kinds';
import { expectRejection } from '../../../../support/rejection';

/** A lookup over a fixed table of ranks that counts its reads. */
function lookupOf(ranks: Record<number, 'merchant' | 'retail'>) {
  const reads: number[] = [];
  const lookup: RankKindLookup = (groupId) => {
    reads.push(groupId);
    return Promise.resolve(ranks[groupId]);
  };
  return { lookup, reads };
}

describe('RankKinds', () => {
  it('answers undefined while no lookup is installed (fail closed)', async () => {
    expect(await new RankKinds().kindOf(1)).toBeUndefined();
  });

  it('reads the kind of a rank through the installed lookup', async () => {
    const ranks = new RankKinds();
    ranks.install(lookupOf({ 1: 'retail', 2: 'merchant' }).lookup);
    expect(await ranks.kindOf(2)).toBe('merchant');
    expect(await ranks.kindOf(1)).toBe('retail');
  });

  it('answers undefined for a rank that does not exist', async () => {
    const ranks = new RankKinds();
    ranks.install(lookupOf({ 1: 'retail' }).lookup);
    expect(await ranks.kindOf(99)).toBeUndefined();
  });

  it('keeps the id of the retail rank once it has seen it, and reads every other rank each time', async () => {
    const { lookup, reads } = lookupOf({ 1: 'retail', 2: 'merchant' });
    const ranks = new RankKinds();
    ranks.install(lookup);
    expect(await ranks.kindOf(1)).toBe('retail');
    expect(await ranks.kindOf(1)).toBe('retail');
    expect(await ranks.kindOf(2)).toBe('merchant');
    expect(await ranks.kindOf(2)).toBe('merchant');
    // One read for the retail rank, two for the merchant rank (a merchant rank may be changed or deleted).
    expect(reads).toEqual([1, 2, 2]);
  });

  it('forgets the retail rank id on request: after a database reset the same id may be a merchant rank', async () => {
    const table: Record<number, 'merchant' | 'retail'> = { 1: 'retail' };
    const ranks = new RankKinds();
    ranks.install((groupId) => Promise.resolve(table[groupId]));
    expect(await ranks.kindOf(1)).toBe('retail');
    table[1] = 'merchant';
    // Kept: the retail rank is never deleted, so the id is not read again.
    expect(await ranks.kindOf(1)).toBe('retail');
    ranks.forgetRetail();
    expect(await ranks.kindOf(1)).toBe('merchant');
  });

  it('does not remember a merchant rank as retail, or a missing rank at all', async () => {
    const { lookup, reads } = lookupOf({ 2: 'merchant' });
    const ranks = new RankKinds();
    ranks.install(lookup);
    expect(await ranks.kindOf(2)).toBe('merchant');
    expect(await ranks.kindOf(5)).toBeUndefined();
    expect(await ranks.kindOf(5)).toBeUndefined();
    expect(reads).toEqual([2, 5, 5]);
  });

  it('refuses a second lookup: the installer runs once, at boot', () => {
    const ranks = new RankKinds();
    ranks.install(lookupOf({}).lookup);
    expect(() => ranks.install(lookupOf({}).lookup)).toThrow(/already installed/);
  });

  it('lets a failing lookup surface: a database error is not an unknown rank', async () => {
    const ranks = new RankKinds();
    ranks.install(() => Promise.reject(new Error('connection lost')));
    await expectRejection(ranks.kindOf(1), 'connection lost');
  });
});
