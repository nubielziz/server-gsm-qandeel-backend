// Blocklist: the one writer and matcher of `blocklist_entries` (map domain K, stage 18). The staff routes, the risk refund, the customer
// block and the chargeback of the payments feature all add entries through it; the checkout and the screening ask it what is blocked.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { TokenService } from '../../../infra/crypto';
import type { DbExecutor } from '../../../infra/db';
import type { BlocklistEntry, BlocklistKind, BlocklistSource } from '../db/schema';
import { blockDisplay, blockHashInput, normalizeBlockValue } from '../domain/blocklist-values';
import {
  type HashProbe,
  deleteManualEntriesOfCustomer,
  findLiveMatches,
  insertEntriesIgnoringDuplicates,
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
  /** The customer a block came from; only `POST /admin/customers/:id/block` sets it (RESOLUTIONS b2c-5). */
  readonly customerId?: number | null;
  /** When the entry stops blocking; `null` for ever. */
  readonly expiresAt?: Date | null;
}

/** What to look up. Every field is optional; a missing one is not checked. */
export interface BlockProbeInput {
  readonly email?: string | null;
  readonly imei?: string | null;
  readonly card?: string | null;
  /** Countries to check (the checkout's tax country, the IP country). */
  readonly countries?: ReadonlyArray<string | null | undefined>;
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
 * (decision 019) plus a masked display, so the table never holds a readable email or IMEI. An entry past its `expires_at` does not
 * block (the clock's time is a parameter, decision 031).
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
   * Why: a system caller (a customer block, a risk refund, a chargeback) must not fail a whole transaction because one value is
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
          valueHash: this.tokens.hash(blockHashInput(request.kind, value.value)),
          display: blockDisplay(request.kind, value.value),
          reason: request.reason,
          expiresAt: request.expiresAt ?? null,
          source: request.source,
          customerId: request.customerId ?? null,
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
   * Removes the manual entries one customer's block added.
   *
   * Why: RESOLUTIONS b2c-5: unblocking lifts only what the block added (`customer_id = :id AND source = 'manual'`); an entry from a
   * risk refund, a chargeback or a manual add, or one another customer's block already held, stays.
   *
   * @param tx the caller's transaction
   * @param customerId the customer being unblocked
   * @returns the removed entries
   */
  removeAddedByBlockOf(tx: DbExecutor, customerId: number): Promise<BlocklistEntry[]> {
    return deleteManualEntriesOfCustomer(tx, customerId);
  }

  /**
   * Finds what a payment, a checkout or a registration matches on the blocklist.
   *
   * @param db the database or a transaction
   * @param probe the email, IMEI, card fingerprint and countries to look up
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
    const imei = probe.imei === undefined || probe.imei === null ? undefined : normalizeBlockValue('imei', probe.imei);
    if (imei?.ok) probes.push({ kind: 'imei', valueHash: this.hashOf('imei', imei.value) });
    if (probe.card) probes.push({ kind: 'card', valueHash: this.hashOf('card', probe.card.trim()) });
    for (const country of probe.countries ?? []) {
      const code = country === undefined || country === null ? undefined : normalizeBlockValue('country', country);
      if (code?.ok) probes.push({ kind: 'country', valueHash: this.hashOf('country', code.value) });
    }
    const entries = await findLiveMatches(db, probes, this.clock.now());
    return entries.map((entry) => ({
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
   * Why: RULES risk 5: a blocked email or domain cannot sign up, sign in by link, be given to a customer by staff or open a checkout. The
   * customers module asks this instead of reading the table (decision 016).
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
    return this.tokens.hash(blockHashInput(kind, normalized));
  }
}
