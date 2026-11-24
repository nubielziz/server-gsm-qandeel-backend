// The boot check of LOOKUP_HASH_KEY (decision 054): the API and the worker compare the key with the marker the first
// start stored, so a changed key cannot silently switch off the stored lookups. The marker lives in the platform module's settings table.
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { databaseFailureOf, safeErrorText } from '../../../common/errors';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { insertSettingIfAbsent } from './settings.repository';
import { SettingsService } from './settings.service';

/**
 * The settings key of the marker.
 *
 * Why: its last word is a secret name, so `GET /admin/settings` never lists it, and it is not in the settings registry, so
 * `PATCH /admin/settings` refuses it: no settings route reads or changes it (decision 054).
 */
export const LOOKUP_KEY_CHECK_SETTING = 'system.lookupKeyCheckHash';

/** The fixed label the marker is the lookup hash of. */
export const LOOKUP_KEY_CHECK_LABEL = 'lookup-hash-key-check';

/** What one check found: no marker yet (written now), the same key, a changed key, or no database answer (outside production). */
export type LookupKeyVerdict = 'first' | 'same' | 'changed' | 'unreachable';

/** The sentence of a changed key; it names the setting, never a value. */
export const LOOKUP_KEY_CHANGED =
  'is not the key the stored lookups were made with: blocklist entries, duplicate checks, unsubscribe links and the ' +
  "shop's link tokens would stop matching. Set it back to that key (docs/OPERATIONS.md section 5).";

/** The sentence of a check the database did not answer. */
const NO_ANSWER = 'could not be checked against the stored lookups: the database did not answer';

/** SQLSTATEs of a server that does not take a statement now: shutting down, starting up, or out of connection slots. */
const NOT_NOW_STATES = new Set(['57P01', '57P02', '57P03', '53300']);

/**
 * Whether a failure of the check means that the database did not answer.
 *
 * A database failure without a SQLSTATE never got the server's answer (refused, reset, timed out or closed); class 08 and the
 * states above are the server's own "not now". Any other failure is a fault of its own and is never read as "did not answer".
 */
function isNoAnswer(error: unknown): boolean {
  const failure = databaseFailureOf(error);
  if (failure === undefined) return false;
  if (failure.sqlState === undefined) return true;
  return failure.sqlState.startsWith('08') || NOT_NOW_STATES.has(failure.sqlState);
}

/**
 * Compares `LOOKUP_HASH_KEY` with the marker of the first start.
 *
 * Why: decision 054: every hash stored for later matching is keyed with `LOOKUP_HASH_KEY`; a changed key would let
 * blocked values pass and end every link without an error anywhere. The first start stores `HMAC(LOOKUP_HASH_KEY, label)`; every later
 * start compares. In production a different key stops the process before it serves a request or runs a job (the check runs in
 * `onModuleInit`, before the queue workers start); elsewhere it writes one configuration warning line and goes on. A production process
 * never runs with an unchecked key: when the database does not answer, the start stops (compose starts the process again once
 * Postgres is healthy, and that start checks again); in development and tests one warning line, and the start goes on. Only a
 * connection failure counts as "did not answer"; any other failure of the check stops the start everywhere. Error texts are the
 * sanitised ones (decision 054), never the statement. `db:migrate` does not run it.
 *
 * Side effects: inserts the `settings` row `system.lookupKeyCheckHash` once (insert that does nothing on conflict); logs.
 */
@Injectable()
export class LookupKeyCheck implements OnModuleInit {
  private readonly logger = new Logger('Bootstrap');

  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsService,
    private readonly tokens: TokenService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Runs the check at start.
   *
   * @throws {Error} as {@link LookupKeyCheck.verify}
   */
  async onModuleInit(): Promise<void> {
    await this.verify();
  }

  /**
   * Checks the key once.
   *
   * @returns what the check found
   * @throws {Error} in production, when the key differs from the marker's or the database did not answer; everywhere, when the check
   *   failed for another reason (the message names the setting and the sanitised failure, never a value)
   */
  async verify(): Promise<LookupKeyVerdict> {
    const expected = this.tokens.lookupHash(LOOKUP_KEY_CHECK_LABEL);
    let stored: unknown;
    try {
      if (await insertSettingIfAbsent(this.db.db, LOOKUP_KEY_CHECK_SETTING, expected)) return 'first';
      stored = await this.settings.get(LOOKUP_KEY_CHECK_SETTING);
    } catch (error) {
      return this.unchecked(error);
    }
    if (stored === expected) return 'same';
    if (this.config.isProduction) throw new Error(`LOOKUP_HASH_KEY ${LOOKUP_KEY_CHANGED}`);
    this.warn(LOOKUP_KEY_CHANGED);
    return 'changed';
  }

  /**
   * What a check that failed does: stop the start, or, outside production when the database did not answer, warn.
   *
   * The thrown error has no `cause`: Drizzle's message of the failure is the statement with its values (decision 054); the
   * sanitised text stands in for it.
   */
  private unchecked(error: unknown): 'unreachable' {
    const reason = safeErrorText(error);
    if (!isNoAnswer(error))
      throw new Error(`LOOKUP_HASH_KEY could not be checked against the stored lookups: ${reason}`);
    if (this.config.isProduction) {
      throw new Error(
        `LOOKUP_HASH_KEY ${NO_ANSWER} (${reason}). A production process does not start with an unchecked key; its next start checks again.`,
      );
    }
    this.warn(`${NO_ANSWER}; the next start checks again.`);
    return 'unreachable';
  }

  /** One line on the configuration warnings channel (the shape main.ts and worker.ts use). */
  private warn(warning: string): void {
    this.logger.warn({ msg: 'Configuration warning', variable: 'LOOKUP_HASH_KEY', warning });
  }
}
