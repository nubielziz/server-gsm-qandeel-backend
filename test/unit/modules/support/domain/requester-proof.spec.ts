// Unit tests of the proof of a ticket requester's address (decision 053): when a ticket counts as proven and what the two staff notes say.
import { describe, expect, it } from 'bun:test';
import {
  PROVEN_TICKET_NOTE,
  UNPROVEN_TICKET_NOTE,
  isRequesterProven,
} from '@src/modules/support/domain/requester-proof';

describe('isRequesterProven', () => {
  it('is true once the address was proven and false while the time is null', () => {
    expect(isRequesterProven({ requesterProvenAt: new Date('2026-11-20T10:00:00.000Z') })).toBe(true);
    expect(isRequesterProven({ requesterProvenAt: null })).toBe(false);
  });
});

describe('the staff notes', () => {
  it('say what is not confirmed and what the link does, in plain words', () => {
    expect(UNPROVEN_TICKET_NOTE).toContain('The address is not confirmed yet');
    expect(UNPROVEN_TICKET_NOTE).toContain('until the link in the receipt email is opened');
    expect(PROVEN_TICKET_NOTE).toContain('the email address is confirmed');
  });
});
