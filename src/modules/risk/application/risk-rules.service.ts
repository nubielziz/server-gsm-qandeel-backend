// RiskRules: the stored risk rules (GET and PUT /admin/risk/rules, map domain K, stage 18). The rules live in the `settings` table
// (B80): seven under the key `riskRules`, and `require3ds` as the storefront policy of the same name.
import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService, type DbExecutor } from '../../../infra/db';
import { AuditService, SettingsReader, SettingsService } from '../../platform';
import {
  REQUIRE_3DS_KEY,
  RISK_RULES_KEY,
  RISK_RULE_IDS,
  RULE_DEFINITIONS,
  type RiskRuleId,
  type RiskRuleSet,
  type RuleChange,
  type RuleInput,
  mergeRules,
  ruleChanges,
  ruleSetFromStored,
  storedRules,
} from '../domain/risk-rules';

/** One rule as the console reads it. */
export interface RuleView {
  readonly id: RiskRuleId;
  readonly on: boolean;
  readonly value: number | null;
  readonly label: string;
  readonly hint: string;
  readonly unit?: string;
}

/** The answer of GET and PUT /admin/risk/rules. */
export interface RulesView {
  readonly rules: RuleView[];
}

/**
 * Reads and saves the risk rules.
 *
 * Why: the map's rules page (`GET`/`PUT /admin/risk/rules`) and the screening both need the same rules. The screening reads them
 * with {@link RiskRules.load} inside its own transaction and never from the cache, because a rule decides whether a customer's
 * money is held (CLAUDE.md: never cache risk decisions). `PUT` takes the whole set, last write wins, and audits each change with the
 * demo's phrases (`turned on risk rule`, `turned off risk rule`, `changed risk rule`).
 *
 * Side effects: `save` upserts the `riskRules` and `require3ds` settings, inserts `audit_logs` rows, and drops the cached settings
 * snapshot after the commit.
 *
 * @see docs/contract/endpoints/risk.md
 */
@Injectable()
export class RiskRules {
  private readonly logger = new Logger(RiskRules.name);

  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsService,
    private readonly reader: SettingsReader,
    private readonly audit: AuditService,
  ) {}

  /**
   * Reads the current rules from the table.
   *
   * @param executor the database or the caller's transaction
   * @returns a complete set (defaults fill what was never saved)
   */
  async load(executor: DbExecutor = this.db.db): Promise<RiskRuleSet> {
    // One after the other: the executor may be a transaction, which is one connection.
    const stored = await this.settings.get(RISK_RULES_KEY, executor);
    const require3ds = await this.settings.get(REQUIRE_3DS_KEY, executor);
    return ruleSetFromStored(stored, require3ds);
  }

  /**
   * Reads the rules in the console's shape.
   *
   * @returns the eight rules in display order
   */
  async view(): Promise<RulesView> {
    return viewOf(await this.load());
  }

  /**
   * Saves the whole set of rules.
   *
   * @param incoming the rules of the request
   * @returns the saved set
   * @throws {AppError} `VALIDATION_FAILED` (422) naming the refused rules, or `reviewThreshold` when it is not below the block
   *   threshold
   */
  async save(incoming: readonly RuleInput[]): Promise<RulesView> {
    const next = await this.db.runInTransaction(async (work) => {
      const before = await this.load(work.tx);
      const merged = mergeRules(before, incoming);
      if (!merged.ok) throw new AppError('VALIDATION_FAILED', { errors: merged.errors });
      const changes = ruleChanges(before, merged.next);
      await this.settings.set(work.tx, RISK_RULES_KEY, storedRules(merged.next));
      if (before.require3ds.on !== merged.next.require3ds.on) {
        await this.settings.set(work.tx, REQUIRE_3DS_KEY, merged.next.require3ds.on);
      }
      await this.record(work.tx, changes);
      work.afterCommit(() =>
        this.reader.invalidate().catch((error: unknown) => {
          this.logger.warn(`Could not drop the settings cache after saving the risk rules: ${String(error)}`);
        }),
      );
      return merged.next;
    });
    return viewOf(next);
  }

  /** One audit row per change; a save that changes nothing still writes one (every staff write is audited). */
  private async record(tx: DbExecutor, changes: readonly RuleChange[]): Promise<void> {
    if (changes.length === 0) {
      await this.audit.record(tx, { action: 'saved risk rules', entityType: 'setting', entityLabel: 'risk rules' });
      return;
    }
    for (const change of changes) {
      const label = RULE_DEFINITIONS[change.id].label;
      await this.audit.record(tx, {
        action:
          change.kind === 'turned_on'
            ? 'turned on risk rule'
            : change.kind === 'turned_off'
              ? 'turned off risk rule'
              : 'changed risk rule',
        entityType: 'setting',
        entityLabel: label,
        before: change.kind === 'value' ? { value: change.from.value } : { on: change.from.on },
        after: change.kind === 'value' ? { value: change.to.value } : { on: change.to.on },
      });
    }
  }
}

function viewOf(set: RiskRuleSet): RulesView {
  return {
    rules: RISK_RULE_IDS.map((id) => {
      const definition = RULE_DEFINITIONS[id];
      return {
        id,
        on: set[id].on,
        value: set[id].value,
        label: definition.label,
        hint: definition.hint,
        ...(definition.unit === undefined ? {} : { unit: definition.unit }),
      };
    }),
  };
}
