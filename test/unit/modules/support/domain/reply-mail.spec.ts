// Unit tests of the email fallback of staff replies (feature 28, rule 9): the text of the one mail that carries the unseen replies (1, 10
// and 12 of them, files counted), when the mail is due, and which replies still count as unseen.
import { describe, expect, it } from 'bun:test';
import { MAX_MAILED_REPLIES, replyMailDueAt, replyMailText, unseenAfter } from '@src/modules/support/domain/reply-mail';

const replies = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ body: `Reply ${index + 1}`, fileCount: 0 }));

describe('replyMailText', () => {
  it('is the reply itself for one reply', () => {
    expect(replyMailText(replies(1))).toBe('Reply 1');
  });

  it('joins ten replies oldest first with a blank line, and counts no earlier ones', () => {
    const text = replyMailText(replies(MAX_MAILED_REPLIES));
    expect(text.split('\n\n')).toEqual(replies(10).map((reply) => reply.body));
    expect(text).not.toContain('earlier');
  });

  it('spells out the newest ten of twelve after a line that counts the two earlier ones', () => {
    const parts = replyMailText(replies(12)).split('\n\n');
    expect(parts[0]).toBe('… and 2 earlier messages');
    expect(parts.slice(1)).toEqual(
      replies(12)
        .slice(2)
        .map((reply) => reply.body),
    );
    expect(replyMailText(replies(11)).split('\n\n')[0]).toBe('… and 1 earlier message');
  });

  it('counts the files of a reply and shows a files-only reply as the count', () => {
    expect(
      replyMailText([
        { body: 'Here is the invoice.', fileCount: 1 },
        { body: '', fileCount: 3 },
      ]),
    ).toBe('Here is the invoice.\n(1 file attached)\n\n(3 files attached)');
  });
});

describe('replyMailDueAt', () => {
  const now = new Date('2026-11-15T10:00:00.000Z');

  it('starts the delay at the first unseen reply', () => {
    expect(replyMailDueAt(null, now, 5).toISOString()).toBe('2026-11-15T10:05:00.000Z');
  });

  it('keeps the due time a waiting reply set, so later replies join the same mail', () => {
    const due = new Date('2026-11-15T10:02:00.000Z');
    expect(replyMailDueAt(due, now, 5)).toBe(due);
  });
});

describe('unseenAfter', () => {
  it('is the larger of the requester’s mark and the newest mailed reply', () => {
    expect(unseenAfter(null, null)).toBe(0);
    expect(unseenAfter(40, null)).toBe(40);
    expect(unseenAfter(40, 52)).toBe(52);
    expect(unseenAfter(60, 52)).toBe(60);
  });
});
