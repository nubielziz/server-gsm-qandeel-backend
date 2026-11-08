// Tests of the derived help slug: build it from the id and the question, read the id back, tolerate an edited question.
import { describe, expect, it } from 'bun:test';
import { helpIdOfSlug, helpSlugOf } from './help-slug';

describe('helpSlugOf', () => {
  it('puts the id before the words of the question', () => {
    expect(helpSlugOf({ id: 10, question: 'How do I find my IMEI?' })).toBe('10-how-do-i-find-my-imei');
  });

  it('is just the id when the question has no Latin letters', () => {
    expect(helpSlugOf({ id: 7, question: 'كيف أجد الرقم؟' })).toBe('7');
  });

  it('keeps the words short and never ends on a hyphen', () => {
    const slug = helpSlugOf({ id: 3, question: `${'word '.repeat(40)}` });
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('helpIdOfSlug', () => {
  it('reads the id and ignores the words, so a link survives an edited question', () => {
    expect(helpIdOfSlug('10-how-do-i-find-my-imei')).toBe(10);
    expect(helpIdOfSlug('10-an-older-wording')).toBe(10);
    expect(helpIdOfSlug('7')).toBe(7);
  });

  it.each(['', 'how-do-i', '0-zero', '-5', '10_words', '10-Words', '12345678901234567890'])('refuses %p', (value) => {
    expect(helpIdOfSlug(value)).toBeUndefined();
  });
});
