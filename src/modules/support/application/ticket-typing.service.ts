// TicketTypingService: "is typing" of the support chat (feature 28, rule 2): a throttled ping that is never stored. One Redis key per
// party and ticket (`SET NX PX 2500`) turns a burst of pings into one doorbell every 2.5 s.
import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { LogThrottle } from '../../../common/log-throttle';
import { withTimeout } from '../../../common/timeout';
import { CacheKeys } from '../../../infra/cache';
import { DbService } from '../../../infra/db';
import { RedisService, withoutCredentials } from '../../../infra/redis';
import { findTicket } from '../infra/ticket.repository';
import { isLockedForRequester } from './requester-lock';
import { TicketEvents, type TypingParty } from './ticket-events';

/** How long one typing ping silences the next ones of the same party: one doorbell per 2.5 s. */
export const TYPING_THROTTLE_MS = 2500;
/** A typing ping waits for Redis at most this long; it is worth nothing later. */
const REDIS_TIMEOUT_MS = 500;
/** One log line per interval while the cache Redis fails (every ping would repeat it). */
const LOG_INTERVAL_MS = 30_000;

/**
 * Rings the typing doorbell of a ticket, at most once per party every 2.5 s.
 *
 * Why: rule 2: typing is ephemeral, never stored and never replayed. Staff typing a reply is shown to the requester ("Support is
 * typing…"), a note to other staff only (the source decides), the requester's typing to staff. The throttle is a key on the cache Redis
 * (`gsm:{env}:support:typing:{ticketId}:{r|s<staffId>}`, `SET NX PX 2500`): set means ring, not set means a ring went out a moment ago.
 * When Redis fails nothing rings and nothing is thrown: the caller always answers `204`. A resolved ticket is closed for its requester
 * (B220, owner decision 2026-11-15), so the requester's ping on one still answers `204` but rings nothing; staff typing is unaffected
 * (a note is allowed on a resolved ticket).
 *
 * Side effects: a read of the ticket; one `SET` on the cache Redis (none for a requester's ping on a resolved ticket); `PUBLISH` of the
 * doorbell when the key was set. No row, no audit.
 *
 * @see docs/cache-keys.md
 */
@Injectable()
export class TicketTypingService {
  private readonly logger = new Logger(TicketTypingService.name);
  private readonly throttle = new LogThrottle(LOG_INTERVAL_MS);

  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly keys: CacheKeys,
    private readonly events: TicketEvents,
  ) {}

  /**
   * Records one typing ping.
   *
   * @param ticketId the ticket (the one the link opened, or the console's id)
   * @param party the requester, or the staff member with `reply` or `note`
   * @returns true when a doorbell rang, false when the ping was throttled, Redis failed or the requester's ticket is resolved
   * @throws {AppError} `NOT_FOUND` for a staff ping on a ticket that does not exist
   */
  async ping(ticketId: number, party: TypingParty): Promise<boolean> {
    const ticket = await findTicket(this.db.db, ticketId);
    if (party.by === 'staff' && !ticket) throw new AppError('NOT_FOUND', { detail: 'No ticket has this id.' });
    // Judged before the throttle key is set, so a ping on a closed ticket leaves no key that would absorb the first ping after a reopen.
    if (party.by === 'requester' && (!ticket || isLockedForRequester(ticket))) return false;
    const key = this.keys.supportTyping(ticketId, party.by === 'staff' ? `s${party.staffId}` : 'r');
    try {
      const set = await withTimeout(
        this.redis.cache.set(key, '1', 'PX', TYPING_THROTTLE_MS, 'NX'),
        REDIS_TIMEOUT_MS,
        'typing throttle',
      );
      if (set !== 'OK') return false;
    } catch (error) {
      const allowed = this.throttle.attempt('typing');
      if (allowed) {
        this.logger.warn(
          `The cache Redis failed; a typing ping rang nothing (${allowed.suppressed} similar lines dropped): ${withoutCredentials(String(error))}`,
        );
      }
      return false;
    }
    this.events.typing(ticketId, party);
    return true;
  }
}
