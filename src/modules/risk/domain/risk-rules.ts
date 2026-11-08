// The risk rules and their thresholds (feature 18, GET and PUT /admin/risk/rules): the eight rule ids of the console, their
// defaults (the demo's rr1..rr8), what each rule's number means, and the validation of a saved set. Pure, no database.
import type { FieldError } from '../../../common/errors';

/**
 * The key of the settings row that stores the rules the risk module owns.
 *
 * Why: the map keeps the rules in `settings` (B80). `require3ds` is the one rule that is not stored under this key: it is the
 * storefront policy of the same name, so the rule and the policy are one stored value (RESOLUTIONS M168).
 */
export const RISK_RULES_KEY = 'riskRules';

/** The key of the storefront policy the `require3ds` rule mirrors. */
export const REQUIRE_3DS_KEY = 'require3ds';

/**
 * The rule ids, in the order the console shows them.
 *
 * Why: the console's words (M110): the ids are part of the wire, the labels and hints are the demo's.
 */
export const RISK_RULE_IDS = [
  'blockBlacklistedImei',
  'reviewThreshold',
  'blockThreshold',
  'maxOrdersPerEmail',
  'reviewFirstOrderAbove',
  'require3ds',
  'reviewIpCountryMismatch',
  'blockDisposableEmail',
] as const;

/** One value of {@link RISK_RULE_IDS}. */
export type RiskRuleId = (typeof RISK_RULE_IDS)[number];

/** A rule as stored: its switch and, for the four numeric rules, its number. */
export interface RuleState {
  readonly on: boolean;
  readonly value: number | null;
}

/** Every rule's state, by id. */
export type RiskRuleSet = Readonly<Record<RiskRuleId, RuleState>>;

/** The words and the number kind of one rule. */
interface RuleDefinition {
  readonly label: string;
  readonly hint: string;
  /** The unit of the number; absent for a plain switch. */
  readonly unit?: string;
  /** The value a fresh shop starts with; `null` for a plain switch. */
  readonly defaultValue: number | null;
  readonly defaultOn: boolean;
}

/**
 * The definition of each rule: the demo's label, hint, unit and default (`S.risk.rules`, rr1 to rr8).
 *
 * Why: the console prefers the server's wording, and a shop that never saved a rule must behave like the demo.
 */
export const RULE_DEFINITIONS: Readonly<Record<RiskRuleId, RuleDefinition>> = {
  blockBlacklistedImei: {
    label: 'Block blacklisted IMEIs before payment',
    hint: 'Looked up in the GSMA blacklist at checkout. The customer sees why and is not charged.',
    defaultValue: null,
    defaultOn: true,
  },
  reviewThreshold: {
    label: 'Hold orders scoring at least',
    hint: 'Held orders wait in the risk queue and are not sent to a supplier.',
    unit: 'points',
    defaultValue: 50,
    defaultOn: true,
  },
  blockThreshold: {
    label: 'Block orders scoring at least',
    hint: 'The payment is cancelled automatically.',
    unit: 'points',
    defaultValue: 80,
    defaultOn: true,
  },
  maxOrdersPerEmail: {
    label: 'Maximum orders per email in 24 hours',
    hint: 'Stops card testing and scripted abuse.',
    unit: 'orders',
    defaultValue: 3,
    defaultOn: true,
  },
  reviewFirstOrderAbove: {
    label: 'Hold the first order of a new customer above',
    hint: 'First orders above this amount are held for a person to look at.',
    unit: 'USD',
    defaultValue: 40,
    defaultOn: true,
  },
  require3ds: {
    label: 'Require 3D Secure on card payments',
    hint: 'Moves chargeback liability to the card issuer for most fraud disputes.',
    defaultValue: null,
    defaultOn: true,
  },
  reviewIpCountryMismatch: {
    label: 'Hold when the IP country differs from the card country',
    hint: 'Adds 25 points to the score.',
    defaultValue: null,
    defaultOn: true,
  },
  blockDisposableEmail: {
    label: 'Block disposable email domains',
    hint: 'Temporary mailboxes cannot receive the result reliably.',
    defaultValue: null,
    defaultOn: false,
  },
};

/** The largest number a numeric rule accepts (points, orders, whole USD): far above any real setting, below integer limits. */
export const MAX_RULE_VALUE = 1_000_000;

/** The rule ids that carry a number. */
export const NUMERIC_RULE_IDS: readonly RiskRuleId[] = RISK_RULE_IDS.filter(
  (id) => RULE_DEFINITIONS[id].defaultValue !== null,
);

/**
 * Tells whether a text is a rule id.
 *
 * @param id any text
 * @returns true for one of the eight ids
 */
export function isRiskRuleId(id: string): id is RiskRuleId {
  return (RISK_RULE_IDS as readonly string[]).includes(id);
}

/**
 * The rules of a shop that never saved any.
 *
 * @returns the defaults of {@link RULE_DEFINITIONS}
 */
export function defaultRuleSet(): RiskRuleSet {
  return Object.fromEntries(
    RISK_RULE_IDS.map((id) => [id, { on: RULE_DEFINITIONS[id].defaultOn, value: RULE_DEFINITIONS[id].defaultValue }]),
  ) as RiskRuleSet;
}

/**
 * Reads the stored rules, filling what is missing or damaged with the defaults.
 *
 * Why: a rule row that was never saved, or holds something unexpected (a hand-edited setting), must not stop the shop from
 * selling: the default applies, as it does for the storefront switches.
 *
 * @param stored the JSON of the `riskRules` setting (any value)
 * @param require3ds the storefront policy `require3ds` (any value; the rule mirrors it)
 * @returns a complete set
 */
export function ruleSetFromStored(stored: unknown, require3ds: unknown): RiskRuleSet {
  const defaults = defaultRuleSet();
  const source = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored : {};
  const result: Record<string, RuleState> = {};
  for (const id of RISK_RULE_IDS) {
    const raw = (source as Record<string, unknown>)[id];
    const fallback = defaults[id];
    if (typeof raw !== 'object' || raw === null) {
      result[id] = fallback;
      continue;
    }
    const { on, value } = raw as { on?: unknown; value?: unknown };
    result[id] = {
      on: typeof on === 'boolean' ? on : fallback.on,
      value:
        fallback.value === null
          ? null
          : typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_RULE_VALUE
            ? value
            : fallback.value,
    };
  }
  result.require3ds = { on: typeof require3ds === 'boolean' ? require3ds : defaults.require3ds.on, value: null };
  return result as RiskRuleSet;
}

/** One rule of a saved set, as the console sends it. */
export interface RuleInput {
  readonly id: string;
  readonly on: boolean;
  readonly value: number | null;
}

/** The outcome of judging a saved set. */
export type RuleMerge =
  { readonly ok: true; readonly next: RiskRuleSet } | { readonly ok: false; readonly errors: FieldError[] };

/**
 * Applies a saved set to the stored one and judges the result.
 *
 * Why: `PUT /admin/risk/rules` carries the whole set with one change applied. A rule the request does not name keeps its stored
 * value; an unknown id, a number that is not a whole number from 0, or a number on a plain switch is `422` on that id; a numeric
 * rule sent with `null` keeps its stored number; and the review threshold must stay below the block threshold, whether or not
 * either switch is on (`422` on `reviewThreshold`, the console puts the message under that field).
 *
 * @param current the stored rules
 * @param incoming the rules of the request
 * @returns the next set, or one error per refused rule
 */
export function mergeRules(current: RiskRuleSet, incoming: readonly RuleInput[]): RuleMerge {
  const errors: FieldError[] = [];
  const next: Record<string, RuleState> = { ...current };
  const seen = new Set<string>();
  for (const rule of incoming) {
    if (!isRiskRuleId(rule.id)) {
      errors.push({ field: rule.id, code: 'unknown_rule', message: 'Unknown rule.' });
      continue;
    }
    if (seen.has(rule.id)) {
      errors.push({ field: rule.id, code: 'duplicate_rule', message: 'This rule is listed twice.' });
      continue;
    }
    seen.add(rule.id);
    const numeric = RULE_DEFINITIONS[rule.id].defaultValue !== null;
    if (!numeric && rule.value !== null) {
      errors.push({ field: rule.id, code: 'no_number', message: 'This rule has no number.' });
      continue;
    }
    if (rule.value !== null && (!Number.isInteger(rule.value) || rule.value < 0 || rule.value > MAX_RULE_VALUE)) {
      errors.push({ field: rule.id, code: 'invalid_number', message: 'Enter a whole number.' });
      continue;
    }
    next[rule.id] = { on: rule.on, value: numeric ? (rule.value ?? current[rule.id].value) : null };
  }
  const review = next.reviewThreshold?.value;
  const block = next.blockThreshold?.value;
  if (errors.length === 0 && review != null && block != null && review >= block) {
    errors.push({
      field: 'reviewThreshold',
      code: 'review_not_below_block',
      message: 'The review threshold must be lower than the block threshold.',
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, next: next as RiskRuleSet };
}

/** One change between two rule sets. */
export interface RuleChange {
  readonly id: RiskRuleId;
  readonly kind: 'turned_on' | 'turned_off' | 'value';
  readonly from: RuleState;
  readonly to: RuleState;
}

/**
 * Lists what changed between two rule sets.
 *
 * Why: the audit log names each change as the demo does (`turned on risk rule`, `turned off risk rule`, `changed risk rule`).
 *
 * @param before the stored rules
 * @param after the saved rules
 * @returns one change per rule whose switch or number differs; a rule whose switch and number both changed is two changes
 */
export function ruleChanges(before: RiskRuleSet, after: RiskRuleSet): RuleChange[] {
  const changes: RuleChange[] = [];
  for (const id of RISK_RULE_IDS) {
    const from = before[id];
    const to = after[id];
    if (from.on !== to.on) changes.push({ id, kind: to.on ? 'turned_on' : 'turned_off', from, to });
    if (from.value !== to.value) changes.push({ id, kind: 'value', from, to });
  }
  return changes;
}

/**
 * The rules as the settings row stores them (everything except the mirrored `require3ds`).
 *
 * @param set a complete set
 * @returns the JSON for the `riskRules` setting
 */
export function storedRules(set: RiskRuleSet): Record<string, RuleState> {
  return Object.fromEntries(RISK_RULE_IDS.filter((id) => id !== 'require3ds').map((id) => [id, set[id]]));
}
