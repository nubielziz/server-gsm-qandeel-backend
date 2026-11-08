// Unit tests of the ticket status codec and the staff moves (RESOLUTIONS b2c-2).
import { describe, expect, it } from 'bun:test';
import { TICKET_STATUSES } from '../db/schema';
import { WIRE_TICKET_STATUSES, fromWireStatus, judgeStatusMove, toWireStatus } from './ticket-status';

describe('the status codec', () => {
  it('sends pending_customer as pending and the other stored words unchanged', () => {
    expect(toWireStatus('pending_customer')).toBe('pending');
    expect(toWireStatus('new')).toBe('new');
    expect(toWireStatus('open')).toBe('open');
    expect(toWireStatus('resolved')).toBe('resolved');
  });

  it('reads pending as pending_customer and is the inverse of toWireStatus for every stored word', () => {
    expect(fromWireStatus('pending')).toBe('pending_customer');
    for (const stored of TICKET_STATUSES) expect(fromWireStatus(toWireStatus(stored))).toBe(stored);
    expect(WIRE_TICKET_STATUSES).toEqual(['new', 'open', 'pending', 'resolved']);
  });
});

describe('judgeStatusMove', () => {
  it('lets staff open, wait on the customer or resolve a ticket that is not resolved', () => {
    expect(judgeStatusMove('new', 'open').ok).toBe(true);
    expect(judgeStatusMove('new', 'pending_customer').ok).toBe(true);
    expect(judgeStatusMove('new', 'resolved').ok).toBe(true);
    expect(judgeStatusMove('open', 'pending_customer').ok).toBe(true);
    expect(judgeStatusMove('open', 'resolved').ok).toBe(true);
    expect(judgeStatusMove('pending_customer', 'open').ok).toBe(true);
    expect(judgeStatusMove('pending_customer', 'resolved').ok).toBe(true);
  });

  it('reopens a resolved ticket to open and refuses any other move out of resolved', () => {
    expect(judgeStatusMove('resolved', 'open').ok).toBe(true);
    expect(judgeStatusMove('resolved', 'pending_customer')).toEqual({
      ok: false,
      message: 'A resolved ticket can only be reopened.',
    });
    expect(judgeStatusMove('resolved', 'new').ok).toBe(false);
  });

  it('never moves a ticket back to new', () => {
    expect(judgeStatusMove('open', 'new')).toEqual({ ok: false, message: 'A ticket cannot go back to new.' });
    expect(judgeStatusMove('pending_customer', 'new').ok).toBe(false);
  });
});
