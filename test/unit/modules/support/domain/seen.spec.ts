// Unit tests of the seen marks of a ticket (feature 28, rule 3): each side marks only the other side's messages it can see, a mark only
// moves forward, and `hasUnread` is the other side's newest message after the mark.
import { describe, expect, it } from 'bun:test';
import { canMarkSeen, hasUnread, movesSeenMark } from '@src/modules/support/domain/seen';

describe('canMarkSeen', () => {
  const staffReply = { ticketId: 5, authorType: 'staff', isInternal: false } as const;
  const note = { ticketId: 5, authorType: 'staff', isInternal: true } as const;
  const system = { ticketId: 5, authorType: 'system', isInternal: true } as const;
  const customer = { ticketId: 5, authorType: 'customer', isInternal: false } as const;
  const merchant = { ticketId: 5, authorType: 'client', isInternal: false } as const;

  it('lets the requester mark a public staff message, never a note, a system message or its own', () => {
    expect(canMarkSeen('requester', 5, staffReply)).toBe(true);
    expect(canMarkSeen('requester', 5, note)).toBe(false);
    expect(canMarkSeen('requester', 5, system)).toBe(false);
    expect(canMarkSeen('requester', 5, customer)).toBe(false);
  });

  it('lets staff mark the requester’s messages only (a customer’s or a merchant’s)', () => {
    expect(canMarkSeen('staff', 5, customer)).toBe(true);
    expect(canMarkSeen('staff', 5, merchant)).toBe(true);
    expect(canMarkSeen('staff', 5, staffReply)).toBe(false);
    expect(canMarkSeen('staff', 5, system)).toBe(false);
  });

  it('refuses a message of another ticket and an id that names none', () => {
    expect(canMarkSeen('requester', 6, staffReply)).toBe(false);
    expect(canMarkSeen('staff', 5, undefined)).toBe(false);
  });
});

describe('movesSeenMark', () => {
  it('moves forward only: a repeat or an older id leaves the mark', () => {
    expect(movesSeenMark(null, 1)).toBe(true);
    expect(movesSeenMark(10, 11)).toBe(true);
    expect(movesSeenMark(10, 10)).toBe(false);
    expect(movesSeenMark(10, 9)).toBe(false);
  });
});

describe('hasUnread', () => {
  it('is true when the other side wrote after the mark', () => {
    expect(hasUnread(12, null)).toBe(true);
    expect(hasUnread(12, 11)).toBe(true);
    expect(hasUnread(12, 12)).toBe(false);
    expect(hasUnread(null, null)).toBe(false);
    expect(hasUnread(null, 4)).toBe(false);
  });
});
