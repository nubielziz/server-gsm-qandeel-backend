// Unit tests of the staff view of a ticket (decisions 047 and 064): the requester's address is masked for a caller who may not read accounts,
// whatever the rank of the requester, and the rank kind comes from the rank the requester's row holds. Pure mapping; no database.
import { describe, expect, it } from 'bun:test';
import type { SupportTicket } from '@src/modules/support/db/schema';
import type { TicketRow } from '@src/modules/support/infra/ticket.repository';
import { toTicketView } from '@src/modules/support/application/ticket-views';

const RETAIL_GROUP = 3;
const MERCHANT_GROUP = 8;
const NOW = new Date('2026-11-15T10:00:00.000Z');

const ticket = (values: Partial<SupportTicket> = {}): SupportTicket => ({
  id: 1043,
  number: 'T-1043',
  subject: 'Invoice question',
  channel: 'web',
  requesterType: 'account',
  requesterId: 7,
  orderId: null,
  category: 'billing',
  priority: 'normal',
  status: 'open',
  assigneeId: null,
  slaDueAt: null,
  firstResponseAt: null,
  resolvedAt: null,
  csatScore: null,
  token: null,
  tokenHash: null,
  tokenEnc: null,
  requesterProvenAt: NOW,
  surveySentAt: null,
  requesterSeenMessageId: null,
  requesterSeenAt: null,
  staffSeenMessageId: null,
  staffSeenAt: null,
  lastRequesterMessageId: null,
  lastStaffMessageId: null,
  replyMailDueAt: null,
  replyMailedMessageId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...values,
});

const row = (values: Partial<TicketRow> = {}): TicketRow => ({
  ticket: ticket(),
  requesterName: 'Zain Mobile Hub',
  requesterEmail: 'desk@zain-hub.example',
  requesterGroupId: MERCHANT_GROUP,
  assigneeName: null,
  ...values,
});

describe('toTicketView: the requester', () => {
  it('masks the address of a merchant rank like any other for a caller who may not read accounts, and shows it for one who may', () => {
    expect(toTicketView(row(), undefined, NOW, 'masked', RETAIL_GROUP).requester).toEqual({
      name: 'Zain Mobile Hub',
      email: 'de•••@zain-hub.example',
      rankKind: 'merchant',
    });
    expect(toTicketView(row(), undefined, NOW, 'full', RETAIL_GROUP).requester.email).toBe('desk@zain-hub.example');
  });

  it('masks the address of a retail account the same way, and says retail for the one retail rank', () => {
    const buyer = row({
      requesterName: 'Victor Hale',
      requesterEmail: 'victor@mail.example',
      requesterGroupId: RETAIL_GROUP,
    });
    expect(toTicketView(buyer, undefined, NOW, 'masked', RETAIL_GROUP).requester).toEqual({
      name: 'Victor Hale',
      email: 'vi•••@mail.example',
      rankKind: 'retail',
    });
    expect(toTicketView(buyer, undefined, NOW, 'full', RETAIL_GROUP).requester.email).toBe('victor@mail.example');
  });

  it('shows no address for a requester that is anonymized or gone, and reads a missing rank as retail (fail closed)', () => {
    const gone = row({ requesterName: 'Deleted customer', requesterEmail: null, requesterGroupId: null });
    expect(toTicketView(gone, undefined, NOW, 'full', RETAIL_GROUP).requester).toEqual({
      name: 'Deleted customer',
      email: null,
      rankKind: 'retail',
    });
  });

  it('names the requester type `account` for every rank', () => {
    expect(toTicketView(row(), undefined, NOW, 'masked', RETAIL_GROUP)).toMatchObject({
      requesterType: 'account',
      requesterId: 7,
    });
  });
});
