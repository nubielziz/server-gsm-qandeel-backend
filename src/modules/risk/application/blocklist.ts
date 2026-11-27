// Blocklist: the one writer and matcher of `blocklist_entries` (map domain K, stage 18). The staff routes, the risk refund, the account
// block and the chargeback of the payments feature all add entries through it; the checkout and the screening ask it what is blocked.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { TokenService } from '../../../infra/crypto';
import type { DbExecutor } from '../../../infra/db';
import type { BlocklistEntry, BlocklistKind, BlocklistSource } from '../db/schema';
import { blockDisplay, blockHashInput, normalizeBlockValue } from '../domain/blocklist-values';
import {
  type HashProbe,
  deleteManualEntriesOfAccount,
  findLiveMatches,
  insertEntriesIgnoringDuplicates,
  widenGuestEntry,
} from '../infra/blocklist.repository';

/** A value to add to the blocklist. */
export interface BlockRequest {
  readonly kind: BlocklistKind;
  /** The value as typed or found; it is normalised here. */
  readonly value: string;
  readonly reason: string;
  readonly source: BlocklistSource;
  /** The staff member who added it; `null` for the system (a chargeback). */
  readonly createdBy: number | null;
  /** The account a block came from (any rank); only `POST /admin/clients/:id/block` sets it (RESOLUTIONS b2c-5, decision 064). */
  readonly accountId?: number | null;
  /** When the entry stops blocking; `null` for ever. */
  readonly expiresAt?: Date | null;
  /**
   * Block guest checkouts only (an email of a guest order whose email belonged to an account before it, decision 050); default false.
   * Such an entry never blocks the account's own sign-in or signed-in checkout.
   */
  readonly guestOnly?: boolean;
}

/** What to look up. Every field is optional; a missing one is not checked. */
export interface BlockProbeInput {
  readonly email?: string | null;
  readonly imei?: string | null;
  /** More IMEIs to check beside `imei` (decision 076: each IMEI of a list); an entry they share matches once. */
  readonly imeis?: ReadonlyArray<string | null | undefined>;
  readonly card?: string | null;
  /** Countries to check (the checkout's tax country, the IP country, the card's country). */
  readonly countries?: ReadonlyArray<string | null | undefined>;
  /**
   * True for a guest use (a checkout opened without a signed-in session, or its payment): entries limited to guest checkouts count too.
   * Default false (decision 050).
   */
  readonly guest?: boolean;
}

/** One entry a probe matched. */
export interface BlockHit {
  readonly entryId: number;
  readonly kind: BlocklistKind;
  readonly source: BlocklistSource;
  /** A sentence for the risk signal list. */
  readonly sentence: string;
}

/** The text of a value kind in a sentence. */
const KIND_WORDS: Readonly<Record<BlocklistKind, string>> = {
  email: 'Email',
  domain: 'Email domain',
  imei: 'IMEI',
  card: 'Card',
  device: 'Device',
  country: 'Country',
};

/**
 * Adds to and asks the blocklist.
 *
 * Why: RESOLUTIONS b2c-5 and the brief: "Blocklist (b2c-5). Manual block adds email, card and IMEI entries with ON CONFLICT DO NOTHING,
 * unblock removes only the customer's manual entries; checks at checkout and registration." Values are stored only as keyed hashes
 * (decision 019; keyed with `LOOKUP_HASH_KEY`, decision 054) plus a masked display, so the table never holds a readable email or IMEI. An entry past its `expires_at` does not
 * block (the clock's time is a parameter, decision 031). Decision 050: an entry has one of two scopes: everywhere (the default), or limited
 * to guest checkouts (`guest_only`), which a guest probe matches and no other use does (sign-in by link, a staff create, an email change,
 * a signed-in checkout or payment, a top-up).
 *
 * Side effects: `add` inserts `blocklist_entries` rows on the caller's transaction (no audit: the caller audits its own action).
 */
@Injectable()
export class Blocklist {
  constructor(
    private readonly tokens: TokenService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Adds entries; a value already blocked is left as it is.
   *
   * Why: a system caller (an account block, a risk refund, a chargeback) must not fail a whole transaction because one value is
   * malformed, so a value that does not fit its kind is skipped, not thrown (the staff route validates what is typed before it gets
   * here and answers `422` on `value`).
   *
   * @param tx the caller's transaction
   * @param requests the values to add
   * @returns the entries that were new; a duplicate (same kind and value) and a malformed value are skipped silently
   */
  async add(tx: DbExecutor, requests: readonly BlockRequest[]): Promise<BlocklistEntry[]> {
    const now = this.clock.now();
    const rows = requests.flatMap((request) => {
      const value = normalizeBlockValue(request.kind, request.value);
      if (!value.ok) return [];
      return [
        {
          kind: request.kind,
          valueHash: this.tokens.lookupHash(blockHashInput(request.kind, value.value)),
          display: blockDisplay(request.kind, value.value),
          reason: request.reason,
          expiresAt: request.expiresAt ?? null,
          source: request.source,
          guestOnly: request.guestOnly ?? false,
          accountId: request.accountId ?? null,
          createdBy: request.createdBy,
          createdAt: now,
          updatedAt: now,
        },
      ];
    });
    // Two requests for the same value in one call would conflict with each other: keep the first.
    const unique = [...new Map(rows.map((row) => [`${row.kind}:${row.valueHash}`, row])).values()];
    return insertEntriesIgnoringDuplicates(tx, unique);
  }

  /**
   * Makes an entry that is limited to guest checkouts a full one.
   *
   * Why: decision 050: a block added by staff for the whole shop (the blocklist route, or the email block of a risk refund) must not be
   * refused because a narrower entry of the same value exists; the entry keeps its row and becomes a full one with the new reason and the
   * staff member. A full entry is left as it is.
   *
   * @param tx the caller's transaction
   * @param request the kind, the value as typed, the new reason and the staff member
   * @returns the widened entry, or `undefined` when no entry limited to guest checkouts has this value (none, or already a full one)
   */
  async widenGuestOnly(
    tx: DbExecutor,
    request: Pick<BlockRequest, 'kind' | 'value' | 'reason' | 'createdBy'>,
  ): Promise<BlocklistEntry | undefined> {
    const value = normalizeBlockValue(request.kind, request.value);
    if (!value.ok) return undefined;
    return widenGuestEntry(tx, {
      kind: request.kind,
      valueHash: this.hashOf(request.kind, value.value),
      reason: request.reason,
      createdBy: request.createdBy,
      now: this.clock.now(),
    });
  }

  /**
   * Removes the manual entries one account's block added.
   *
   * Why: RESOLUTIONS b2c-5: unblocking lifts only what the block added (`account_id = :id AND source = 'manual'`); an entry from a
   * risk refund, a chargeback or a manual add, or one another account's block already held, stays.
   *
   * @param tx the caller's transaction
   * @param accountId the account being unblocked
   * @returns the removed entries
   */
  removeAddedByBlockOf(tx: DbExecutor, accountId: number): Promise<BlocklistEntry[]> {
    return deleteManualEntriesOfAccount(tx, accountId);
  }

  /**
   * Finds what a payment, a checkout or a registration matches on the blocklist.
   *
   * @param db the database or a transaction
   * @param probe the email, IMEI (and any more IMEIs), card fingerprint and countries to look up, and whether this is a guest use (an entry
   *   limited to guest checkouts matches a guest use only)
   * @returns one hit per matching live entry; empty when nothing is blocked
   */
  async match(db: DbExecutor, probe: BlockProbeInput): Promise<BlockHit[]> {
    const probes: HashProbe[] = [];
    const email =
      probe.email === undefined || probe.email === null ? undefined : normalizeBlockValue('email', probe.email);
    if (email?.ok) {
      probes.push({ kind: 'email', valueHash: this.hashOf('email', email.value) });
      const domain = email.value.slice(email.value.lastIndexOf('@') + 1);
      probes.push({ kind: 'domain', valueHash: this.hashOf('domain', domain) });
    }
    for (const raw of [probe.imei, ...(probe.imeis ?? [])]) {
      const imei = raw === undefined || raw === null ? undefined : normalizeBlockValue('imei', raw);
      if (imei?.ok) probes.push({ kind: 'imei', valueHash: this.hashOf('imei', imei.value) });
    }
    if (probe.card) probes.push({ kind: 'card', valueHash: this.hashOf('card', probe.card.trim()) });
    for (const country of probe.countries ?? []) {
      const code = country === undefined || country === null ? undefined : normalizeBlockValue('country', country);
      if (code?.ok) probes.push({ kind: 'country', valueHash: this.hashOf('country', code.value) });
    }
    const entries = await findLiveMatches(db, probes, this.clock.now());
    const usable = probe.guest === true ? entries : entries.filter((entry) => !entry.guestOnly);
    return usable.map((entry) => ({
      entryId: entry.id,
      kind: entry.kind,
      source: entry.source,
      sentence:
        entry.source === 'chargeback' && (entry.kind === 'email' || entry.kind === 'card')
          ? `${KIND_WORDS[entry.kind]} on a previous chargeback`
          : `${KIND_WORDS[entry.kind]} is on the blocklist`,
    }));
  }

  /**
   * Tells whether an email, or the domain it is on, is blocked.
   *
   * Why: RULES risk 5: a blocked email or domain cannot sign up, sign in by link, be given to an account by staff or open a checkout. The
   * customers module asks this instead of reading the table (decision 016). An entry limited to guest checkouts does not count: signing in
   * by link, a staff create and an email change are not guest uses (decision 050).
   *
   * @param db the database or a transaction
   * @param email the email as typed (normalised here)
   * @returns true when a live `email` or `domain` entry matches; false for text that is not an email
   */
  async isEmailBlocked(db: DbExecutor, email: string): Promise<boolean> {
    return (await this.match(db, { email })).length > 0;
  }

  /**
   * The keyed hash a value has in the table.
   *
   * @param kind what the value is
   * @param normalized the normalised value
   * @returns the hash `blocklist_entries.value_hash` holds
   */
  hashOf(kind: BlocklistKind, normalized: string): string {
    return this.tokens.lookupHash(blockHashInput(kind, normalized));
  }
}
