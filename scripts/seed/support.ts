// Seeder of the support module (feature 17): the demo's 15 tickets with their messages and its 8 canned replies, mapped as the frontend
// mocks map them (src/features/support/mocks/store.ts of the frontend): ticket ids and numbers from the demo ids (`T-4202` is id 4202),
// requester ids from the customer and merchant ids (`c28` is 28), message ids in order, `{name}` in a macro becomes `{{name}}`. The reply
// target is worked out with the server's rule, so the inbox shows what the API would have made. Feature 28 adds what the live chat reads: the
// newest message of each side, the seen marks (so some tickets are unread for staff and some for the requester), the delivery channel of a
// public staff message and, when the object store is reachable, one attachment on a customer's follow-up. Runs after identity (staff,
// merchants), orders and customers.
import { and, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { SystemClock } from '../../src/common/clock';
import type { AppConfig } from '../../src/config';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { StorageService } from '../../src/infra/storage';
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

/** The attachment of the demo: the smallest document that starts with the PDF signature, so the download shows a real file. */
const DEMO_PDF = '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';

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
 * Feature 28 (the live chat): each ticket also gets the ids of the newest requester message and the newest public staff message and the
 * seen marks the inbox shows. Staff have seen the requester's messages of every ticket somebody picked up (`new` ones are unread for staff),
 * and the requester has seen the staff replies of a resolved ticket and of one they wrote on again (a reply the requester has not
 * answered is unread for them). A public staff message carries the channel `email`. With `config` (and an object store that answers) the
 * customer's follow-up of the first ticket that has one carries a small PDF, stored as the customer's own upload under the ticket's area,
 * so the demo shows an attachment; without either, no attachment is seeded.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @param config the application configuration, for the object store (the attachment is left out without it)
 * @returns one report per table
 */
export async function seedSupport(db: DbExecutor, demo: DemoSeed, config?: AppConfig): Promise<SeedReport[]> {
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
        // A public staff message reaches the requester by email in the demo (no merchant chat is linked).
        notifyChannel: author.authorType === 'staff' && message.by === 'staff' ? ('email' as const) : null,
        createdAt: new Date(message.ts),
      };
    });
    messages.push(...thread);
    // The live chat's marks (feature 28): the newest message of each side and who has seen what.
    const newest = (side: 'requester' | 'staff') => {
      const found = thread.findLast((message) =>
        side === 'requester' ? message.authorType === ticket.who.type : message.notifyChannel !== null,
      );
      return found && { id: found.id, at: found.createdAt };
    };
    const lastRequester = newest('requester');
    const lastStaff = newest('staff');
    // The requester has seen support's replies when the ticket is resolved or they wrote after the newest one.
    const requesterAnswered = lastRequester !== undefined && lastStaff !== undefined && lastRequester.at > lastStaff.at;
    const requesterSaw = ticket.status === 'resolved' || requesterAnswered ? lastStaff : undefined;
    // Staff have seen the requester's messages of every ticket somebody picked up; a `new` ticket is unread for staff.
    const staffSaw = status === 'new' ? undefined : lastRequester;
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
      lastRequesterMessageId: lastRequester?.id ?? null,
      lastStaffMessageId: lastStaff?.id ?? null,
      requesterSeenMessageId: requesterSaw?.id ?? null,
      requesterSeenAt: requesterSaw ? new Date(ticket.updated) : null,
      staffSeenMessageId: staffSaw?.id ?? null,
      staffSeenAt: staffSaw ? new Date(Math.max(staffSaw.at.getTime(), ticket.firstReplyAt ?? 0)) : null,
      // Nothing waits to be mailed: the seeded replies were delivered when they were written.
      replyMailedMessageId: lastStaff?.id ?? null,
      createdAt: new Date(ticket.created),
      updatedAt: new Date(ticket.updated),
    });
  }
  const attachment = config === undefined ? undefined : await seedAttachment(db, config, tickets, messages);

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
    ...(attachment ? [attachment] : []),
  ];
  for (const table of [s.supportTickets, s.ticketMessages, s.replyTemplates]) await syncIdentity(db, table);
  return reports;
}

/**
 * Stores the demo's attachment and puts it on a customer's follow-up message.
 *
 * Why: feature 28, rule 8: the demo should show a file on a thread. The first customer ticket whose thread has a customer message after a
 * public staff reply gets a small PDF as the customer's own upload (the ticket link's area `tickets-<id>`, a fixed key, so a second run
 * finds it). Needs the object store: when it does not answer, nothing is attached and the seed goes on.
 *
 * @param db the transaction to write with
 * @param config the application configuration (the object store)
 * @param tickets the tickets about to be inserted
 * @param messages the messages about to be inserted; the chosen one gets `fileIds`
 * @returns the report of the `files` table, or `undefined` when no ticket has such a follow-up
 */
async function seedAttachment(
  db: DbExecutor,
  config: AppConfig,
  tickets: ReadonlyArray<typeof s.supportTickets.$inferInsert & { id: number }>,
  messages: Array<typeof s.ticketMessages.$inferInsert & { id: number }>,
): Promise<SeedReport | undefined> {
  const target = tickets
    .flatMap((ticket) => {
      if (ticket.requesterType !== 'customer') return [];
      const thread = messages.filter((message) => message.ticketId === ticket.id);
      const lastReply = thread.findLastIndex((message) => message.notifyChannel != null);
      const followUp = thread.slice(lastReply + 1).find((message) => message.authorType === 'customer');
      return lastReply >= 0 && followUp ? [{ ticket, message: followUp }] : [];
    })
    .at(0);
  if (!target) return undefined;
  const owner = target.message.authorId;
  if (owner == null) return undefined;
  const storage = new StorageService(config, new SystemClock());
  const key = `tickets-${target.ticket.id}/customer-${owner}/demo-receipt.pdf`;
  try {
    const [existing] = await db
      .select({ id: s.files.id })
      .from(s.files)
      .where(and(eq(s.files.bucket, storage.bucket), eq(s.files.key, key)))
      .limit(1);
    if (existing) {
      target.message.fileIds = [existing.id];
      return { table: 'files', inserted: 0, existing: 1 };
    }
    const bytes = new TextEncoder().encode(DEMO_PDF);
    // Only the object store is allowed to fail quietly: a database error must stop the seed.
    const object = await storage.put(key, bytes, { contentType: 'application/pdf' }).catch(() => undefined);
    if (!object) return { table: 'files', inserted: 0, existing: 0 };
    const [row] = await db
      .insert(s.files)
      .values({
        bucket: object.bucket,
        key: object.key,
        filename: 'payment-receipt.pdf',
        mime: 'application/pdf',
        size: object.size,
        sha256: object.sha256,
        ownerType: 'customer',
        ownerId: owner,
        createdAt: target.message.createdAt ?? new Date(),
      })
      .returning({ id: s.files.id });
    target.message.fileIds = [row!.id];
    return { table: 'files', inserted: 1, existing: 0 };
  } finally {
    storage.onApplicationShutdown();
  }
}
