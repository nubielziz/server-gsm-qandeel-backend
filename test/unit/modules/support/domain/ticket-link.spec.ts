// Unit tests of how long a support ticket's link opens it (decision 054): 180 days after resolution, for ever while the ticket is open.
import { describe, expect, it } from 'bun:test';
import {
  TICKET_LINK_DAYS_AFTER_RESOLUTION,
  hasTicketLink,
  ticketLinkOpen,
} from '@src/modules/support/domain/ticket-link';

const DAY_MS = 86_400_000;
const resolvedAt = new Date('2026-05-01T10:00:00.000Z');

describe('ticketLinkOpen', () => {
  it("a resolved ticket's link works until 180 days after resolution", () => {
    const end = resolvedAt.getTime() + TICKET_LINK_DAYS_AFTER_RESOLUTION * DAY_MS;
    expect(TICKET_LINK_DAYS_AFTER_RESOLUTION).toBe(180);
    expect(ticketLinkOpen(resolvedAt, resolvedAt.getTime())).toBe(true);
    expect(ticketLinkOpen(resolvedAt, end - 1)).toBe(true);
    expect(ticketLinkOpen(resolvedAt, end)).toBe(false);
    expect(ticketLinkOpen(resolvedAt, end + 365 * DAY_MS)).toBe(false);
  });

  it('is always open while the ticket is not resolved', () => {
    expect(ticketLinkOpen(null, 0)).toBe(true);
    expect(ticketLinkOpen(null, Date.parse('2100-01-01T00:00:00Z'))).toBe(true);
  });
});

describe('hasTicketLink', () => {
  it('counts either stored form of the link', () => {
    expect(hasTicketLink({ token: 'plain-token-0123456789', tokenHash: null })).toBe(true);
    expect(hasTicketLink({ token: null, tokenHash: 'a'.repeat(64) })).toBe(true);
    expect(hasTicketLink({ token: null, tokenHash: null })).toBe(false);
  });
});
