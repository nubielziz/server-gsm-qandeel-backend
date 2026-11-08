// Seeder of the support module (feature 17): the demo's 15 tickets with their messages and its 8 canned replies, mapped as the frontend
// mocks map them (src/features/support/mocks/store.ts of the frontend): ticket ids and numbers from the demo ids (`T-4202` is id 4202),
// requester ids from the customer and merchant ids (`c28` is 28), message ids in order, `{name}` in a macro becomes `{{name}}`. The reply
// target is worked out with the server's rule, so the inbox shows what the API would have made. Runs after identity (staff, merchants), orders
// and customers.
import { inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { slaDueAt } from '../../src/modules/support';
import { type DemoSeed, demoNumericId, demoRows, toDate } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

import type {
  TicketCategory as Category,
  TicketChannel as Channel,
  TicketPriority as Priority,
} from '../../src/modules/support/db/schema';

interface DemoMessage {
  by: 'customer' | 'staff' | 'note';
  name: string;
  ts: number;
  text: string;
}
interface DemoTicket {
  id: string;
  subject: string;
  channel: Channel;
  who: { type: 'customer' | 'client'; id: string };
  oid: string | null;
  cat: Category;
  prio: Priority;
  status: 'new' | 'open' | 'pending' | 'resolved';
  assignee: string | null;
  created: number;
  updated: number;
  firstReplyAt: number | null;
  csat: number | null;
  msgs: DemoMessage[];
}
interface DemoMacro {
  id: string;
  title: string;
  cat: Category;
  body: string;
}
interface DemoAdmin {
  id: string;
  name: string;
}

const DAY_MS = 86_400_000;

/** The demo writes `{name}`; the API's templates use `{{name}}` (MISMATCHES M142). */
const toApiVariables = (body: string): string => body.replace(/\{(\w+)\}/g, '{{$1}}');

/**
 * Seeds the tickets, their messages and the reply templates of the demo.
 *
 * Why: the console's Support page shows the demo's inbox; with the same ids, subjects, statuses and threads, switching from the mock to
 * the API changes nothing the person can see. A ticket links to its order only when that order exists (storefront orders are seeded with
 * the customers), so a ticket whose order is not there yet is stored without the link rather than refused. A customer ticket gets a
 * random token (nobody can open the ticket page of a seeded ticket by guessing); a merchant ticket has none. The demo's `pending` is the
 * stored `pending_customer`, and a resolved ticket's `resolved_at` is its last activity, as the mock has it.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns one report per table
 */
export async function seedSupport(db: DbExecutor, demo: DemoSeed): Promise<SeedReport[]> {
  const staff = new Map(demoRows<DemoAdmin>(demo, 'admins').map((admin) => [admin.name, demoNumericId(admin.id)]));
  const demoTickets = demoRows<DemoTicket>(demo, 'tickets');
  const orderIds = new Set(
    (
      await db
        .select({ id: s.orders.id })
        .from(s.orders)
        .where(
          inArray(
            s.orders.id,
            demoTickets.flatMap((ticket) => (ticket.oid === null ? [] : [demoNumericId(ticket.oid)])),
          ),
        )
    ).map((row) => row.id),
  );

  let nextMessageId = 1;
  const tickets: Array<typeof s.supportTickets.$inferInsert & { id: number }> = [];
  const messages: Array<typeof s.ticketMessages.$inferInsert & { id: number }> = [];
  for (const ticket of demoTickets) {
    const id = demoNumericId(ticket.id);
    const requesterId = demoNumericId(ticket.who.id);
    const status = ticket.status === 'pending' ? ('pending_customer' as const) : ticket.status;
    const thread = ticket.msgs.map((message) => {
      const author =
        message.by === 'customer'
          ? ({ authorType: ticket.who.type, authorId: requesterId } as const)
          : message.by === 'note' && message.name === 'System'
            ? ({ authorType: 'system', authorId: null } as const)
            : ({ authorType: 'staff', authorId: staff.get(message.name) ?? null } as const);
      return {
        id: nextMessageId++,
        ticketId: id,
        ...author,
        body: message.text,
        isInternal: message.by === 'note',
        createdAt: new Date(message.ts),
      };
    });
    messages.push(...thread);
    const lastPublic = ticket.msgs.findLast((message) => message.by !== 'note');
    tickets.push({
      id,
      number: ticket.id,
      subject: ticket.subject,
      channel: ticket.channel,
      requesterType: ticket.who.type,
      requesterId,
      orderId: ticket.oid !== null && orderIds.has(demoNumericId(ticket.oid)) ? demoNumericId(ticket.oid) : null,
      category: ticket.cat,
      priority: ticket.prio,
      status,
      assigneeId: ticket.assignee === null ? null : (staff.get(ticket.assignee) ?? null),
      slaDueAt: slaDueAt(
        status,
        ticket.prio,
        lastPublic && { fromRequester: lastPublic.by === 'customer', at: new Date(lastPublic.ts) },
      ),
      firstResponseAt: toDate(ticket.firstReplyAt),
      resolvedAt: ticket.status === 'resolved' ? new Date(ticket.updated) : null,
      csatScore: ticket.csat,
      token: ticket.who.type === 'customer' ? randomBytes(16).toString('base64url') : null,
      createdAt: new Date(ticket.created),
      updatedAt: new Date(ticket.updated),
    });
  }

  const author = staff.get('Rami K.') ?? null;
  const sixtyDaysAgo = new Date(demo.now - 60 * DAY_MS);
  const templates = demoRows<DemoMacro>(demo, 'macros').map((macro) => ({
    id: demoNumericId(macro.id),
    title: macro.title,
    category: macro.cat,
    locale: 'en',
    body: toApiVariables(macro.body),
    shortcut: null,
    createdBy: author,
    createdAt: sixtyDaysAgo,
    updatedAt: sixtyDaysAgo,
  }));

  const reports = [
    await insertRows(db, s.supportTickets, tickets),
    await insertRows(db, s.ticketMessages, messages),
    await insertRows(db, s.replyTemplates, templates),
  ];
  for (const table of [s.supportTickets, s.ticketMessages, s.replyTemplates]) await syncIdentity(db, table);
  return reports;
}
