// Unit tests of the account views of the support chat (feature 28, slice B2): the rows of my tickets (a retail account) and of the portal's
// tickets (a merchant rank), and the portal's conversation. Pure mapping: the shop row carries the link token and the portal's never,
// `hasUnread` is the requester's own side of the seen marks, and the conversation carries no staff detail.
import { describe, expect, it } from 'bun:test';
import type { SupportTicket, TicketMessage } from '@src/modules/support/db/schema';
import type { AccountTicketRow } from '@src/modules/support/infra/account-ticket.repository';
import {
  toClientTicket,
  toClientTicketRow,
  toMyTicketRow,
} from '@src/modules/support/application/account-ticket-views';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 15, 10, minute));

const ticket = (values: Partial<SupportTicket> = {}): SupportTicket => ({
  id: 1043,
  number: 'T-1043',
  subject: 'Invoice question',
  channel: 'web',
  requesterType: 'account',
  requesterId: 7,
  orderId: null,
  category: 'billing',
  priority: 'high',
  status: 'pending_customer',
  assigneeId: 2,
  slaDueAt: at(30),
  firstResponseAt: at(10),
  resolvedAt: null,
  csatScore: null,
  token: null,
  tokenHash: null,
  tokenEnc: null,
  requesterProvenAt: at(0),
  surveySentAt: null,
  requesterSeenMessageId: null,
  requesterSeenAt: null,
  staffSeenMessageId: 9000,
  staffSeenAt: at(5),
  lastRequesterMessageId: 9000,
  lastStaffMessageId: 9001,
  replyMailDueAt: null,
  replyMailedMessageId: null,
  createdAt: at(0),
  updatedAt: at(10),
  ...values,
});

const row = (values: Partial<SupportTicket> = {}): AccountTicketRow => ({
  ticket: ticket(values),
  lastMessageAt: at(10),
  lastMessageFrom: 'support',
});

const message = (id: number, authorType: TicketMessage['authorType'], body: string): TicketMessage => ({
  id,
  ticketId: 1043,
  authorType,
  authorId: authorType === 'system' ? null : 2,
  body,
  isInternal: false,
  fileIds: [],
  notifyChannel: null,
  createdAt: at(id - 8999),
});

describe('toMyTicketRow', () => {
  it('carries the link token and the requester’s own unread state, with the status in the console’s words', () => {
    const view = toMyTicketRow(row(), 'Zk3b0jY8mQe1xVn7hT2cLw');
    expect(view).toEqual({
      number: 'T-1043',
      subject: 'Invoice question',
      category: 'billing',
      status: 'pending',
      orderId: null,
      createdAt: '2026-11-15T10:00:00.000Z',
      updatedAt: '2026-11-15T10:10:00.000Z',
      lastMessageAt: '2026-11-15T10:10:00.000Z',
      lastMessageFrom: 'support',
      hasUnread: true,
      token: 'Zk3b0jY8mQe1xVn7hT2cLw',
    });
  });

  it('is read once the requester marked the newest support message, and unread for a newer one', () => {
    expect(toMyTicketRow(row({ requesterSeenMessageId: 9001 }), 't').hasUnread).toBe(false);
    expect(toMyTicketRow(row({ requesterSeenMessageId: 9000 }), 't').hasUnread).toBe(true);
    expect(toMyTicketRow(row({ lastStaffMessageId: null }), 't').hasUnread).toBe(false);
  });

  it('shows null for a ticket without a public message', () => {
    const empty: AccountTicketRow = { ticket: ticket(), lastMessageAt: null, lastMessageFrom: null };
    expect(toMyTicketRow(empty, 't')).toMatchObject({ lastMessageAt: null, lastMessageFrom: null });
  });
});

describe('toClientTicketRow', () => {
  it('has the ticket id and never a token, even for a ticket that has one', () => {
    const view = toClientTicketRow(row({ token: 'must-not-appear' }));
    expect(view.id).toBe(1043);
    expect(Object.keys(view)).not.toContain('token');
    expect(JSON.stringify(view)).not.toContain('must-not-appear');
  });
});

describe('toClientTicket', () => {
  it('shows the public thread with the seen marks, without a token or any staff detail, whatever an old row holds in its retired columns', () => {
    const view = toClientTicket(
      ticket({ requesterSeenMessageId: 9001, requesterSeenAt: at(12), csatScore: 5, surveySentAt: at(11) }),
      [
        { message: message(9000, 'account', 'Re-issue it, please.'), authorName: 'Zain Mobile Hub' },
        { message: message(9001, 'staff', 'Done.'), authorName: 'Lina S.' },
      ],
      new Map(),
    );
    expect(view).toEqual({
      id: 1043,
      number: 'T-1043',
      subject: 'Invoice question',
      category: 'billing',
      status: 'pending',
      orderId: null,
      createdAt: '2026-11-15T10:00:00.000Z',
      updatedAt: '2026-11-15T10:10:00.000Z',
      resolvedAt: null,
      messages: [
        { id: 9000, from: 'you', body: 'Re-issue it, please.', createdAt: '2026-11-15T10:01:00.000Z', attachments: [] },
        { id: 9001, from: 'support', body: 'Done.', createdAt: '2026-11-15T10:02:00.000Z', attachments: [] },
      ],
      seenByYou: 9001,
      seenBySupport: 9000,
      seenBySupportAt: '2026-11-15T10:05:00.000Z',
    });
    expect(JSON.stringify(view)).not.toContain('Lina');
    expect(Object.keys(view)).not.toContain('csatScore');
    expect(Object.keys(view)).not.toContain('canRate');
  });

  it('leaves out an attachment whose file is gone and keeps the others in order', () => {
    const withFiles = { ...message(9001, 'staff', 'Files.'), fileIds: [3, 4] };
    const files = new Map([[4, { id: 4, filename: 'invoice.pdf', mime: 'application/pdf', size: 2048 }]]);
    const view = toClientTicket(ticket(), [{ message: withFiles, authorName: 'Lina S.' }], files);
    expect(view.messages[0]?.attachments).toEqual([
      { id: 4, filename: 'invoice.pdf', mime: 'application/pdf', size: 2048 },
    ]);
  });
});
