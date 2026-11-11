// Unit tests of the storefront availability rule (feature 22, slice B).
import { describe, expect, it } from 'bun:test';
import { coversSmallestOrder, smallestOrder } from './storefront-availability';

describe('smallestOrder', () => {
  it('is the minimum quantity when no packs are set', () => {
    expect(smallestOrder(1, [])).toBe(1);
    expect(smallestOrder(5, [])).toBe(5);
  });
  it('is the smallest pack when packs are set, whatever the minimum says', () => {
    expect(smallestOrder(1, [10, 5, 25])).toBe(5);
    expect(smallestOrder(100, [50, 100])).toBe(50);
  });
});

describe('coversSmallestOrder', () => {
  it('needs at least the smallest order in stock', () => {
    expect(coversSmallestOrder(0, 1, [])).toBe(false);
    expect(coversSmallestOrder(1, 1, [])).toBe(true);
    expect(coversSmallestOrder(4, 1, [5, 10])).toBe(false);
    expect(coversSmallestOrder(5, 1, [5, 10])).toBe(true);
  });
});
