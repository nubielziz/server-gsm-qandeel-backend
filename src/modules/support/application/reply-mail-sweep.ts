// ReplyMailSweep: the email fallback of staff replies (feature 28, rule 9): every minute, the tickets whose email replies waited
// `support.replyEmailDelayMinutes` without being seen get one mail with all of them (the event of today's reply mail, batched).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { unseenAfter } from '../domain/reply-mail';
import { anyReplyMailDue, finishReplyMail, lockDueReplyMails, unseenEmailReplies } from '../infra/ticket.repository';
import { TicketMailOutbox } from './ticket-mail-outbox';

/** Tickets one pass locks. */
export const REPLY_MAIL_PASS_SIZE = 100;
/** The most passes of one run (10 000 tickets); the rest waits a minute. */
export const REPLY_MAIL_MAX_PASSES = 100;

/** What a sweep did. */
export interface ReplyMailSweepResult {
  /** Tickets whose wait ended. */
  readonly tickets: number;
  /** Mails queued (one per ticket that still had unseen replies). */
  readonly mailed: number;
  /** Tickets whose replies were all seen meanwhile: nothing was mailed. */
  readonly seen: number;
}

/**
 * Mails the unseen email replies whose delay is over, one mail per ticket.
 *
 * Why: rule 9: an email reply is not mailed at once; the requester who has the ticket page open sees it live. When the
 * requester has not seen it after the delay, one email carries every unseen reply of the ticket. A pass locks at most
 * {@link REPLY_MAIL_PASS_SIZE} due tickets in id order with `FOR UPDATE SKIP LOCKED`, so two sweeps at once never take the same ticket,
 * and for each, in the same transaction: the public staff messages on channel `email` after the larger of the requester's mark and the
 * newest mailed reply; none left clears the wait, else the `support.ticket_mail` event (`kind: 'reply'`, `fromMessageId` the first,
 * `messageId` the last) is written, `reply_mailed_message_id` is the last and the wait is cleared. A second run finds nothing to mail for
 * the same replies. An anonymized customer gets nothing (the job re-reads the requester).
 *
 * Side effects: updates `support_tickets` (`reply_mail_due_at`, `reply_mailed_message_id`; `updated_at` stays) and inserts
 * `outbox_events` rows, one transaction per pass. Time comes from the injected clock (decision 031).
 *
 * @see docs/queues.md (support_reply_mail_sweep)
 */
@Injectable()
export class ReplyMailSweep {
  constructor(
    private readonly db: DbService,
    private readonly mail: TicketMailOutbox,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Says whether any ticket's wait is over (a tick with nothing due records no run).
   *
   * @returns true when at least one ticket is due
   */
  due(): Promise<boolean> {
    return anyReplyMailDue(this.db.db, this.clock.now());
  }

  /**
   * Runs the passes until no due ticket is left (or the run's limit).
   *
   * @returns how many waits ended, mails were queued and tickets had nothing left to mail
   */
  async run(): Promise<ReplyMailSweepResult> {
    let tickets = 0;
    let mailed = 0;
    let seen = 0;
    for (let pass = 0; pass < REPLY_MAIL_MAX_PASSES; pass += 1) {
      const done = await this.pass();
      tickets += done.tickets;
      mailed += done.mailed;
      seen += done.seen;
      if (done.tickets < REPLY_MAIL_PASS_SIZE) break;
    }
    return { tickets, mailed, seen };
  }

  /** One pass: the due tickets this sweep could lock, each mailed or cleared, in one transaction. */
  private pass(): Promise<ReplyMailSweepResult> {
    return this.db.runInTransaction(async (work) => {
      const { tx } = work;
      const due = await lockDueReplyMails(tx, this.clock.now(), REPLY_MAIL_PASS_SIZE);
      let mailed = 0;
      for (const ticket of due) {
        const replies = await unseenEmailReplies(
          tx,
          ticket.id,
          unseenAfter(ticket.requesterSeenMessageId, ticket.replyMailedMessageId),
        );
        const first = replies[0];
        const last = replies.at(-1);
        if (!first || !last) {
          await finishReplyMail(tx, ticket.id, undefined);
          continue;
        }
        await this.mail.reply(work, ticket, last, 'email', first);
        await finishReplyMail(tx, ticket.id, last.id);
        mailed += 1;
      }
      return { tickets: due.length, mailed, seen: due.length - mailed };
    });
  }
}
