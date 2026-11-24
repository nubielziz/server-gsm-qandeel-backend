// Which inputs each risk rule and signal needs that only some installations can supply, and which of them this installation lacks
// (decision 050). Pure, no database.
import { RISK_RULE_IDS, RULE_DEFINITIONS, type RiskRuleId, type RiskRuleSet } from './risk-rules';
import { CARD_DETAILS_MISSING_SIGNAL, SIGNAL_POINTS } from './risk-scoring';

/**
 * The inputs a rule or a signal can need that not every installation supplies: the visitor's country from a trusted proxy header.
 *
 * Why: decision 050 (W1-D-2): a rule that is switched on but never receives its input looks active and protects nothing; the boot check names it.
 */
export const OPTIONAL_INPUTS = ['ipCountry'] as const;

/** One value of {@link OPTIONAL_INPUTS}. */
export type OptionalInput = (typeof OPTIONAL_INPUTS)[number];

/** The name of a signal of {@link SIGNAL_POINTS}. */
export type SignalName = keyof typeof SIGNAL_POINTS;

/**
 * The optional input each rule and each signal cannot work without (`null`: none).
 *
 * Why: decision 050: a rule or signal added later must say what it needs, or the type stops the build, so no rule can look active without
 * an input (W1-D-2).
 */
export const NEEDED_INPUT: Readonly<Record<RiskRuleId | SignalName, OptionalInput | null>> = {
  reviewThreshold: null,
  blockThreshold: null,
  maxOrdersPerEmail: null,
  reviewFirstOrderAbove: null,
  require3ds: null,
  reviewIpCountryMismatch: 'ipCountry',
  blockDisposableEmail: null,
  disposableEmail: null,
  firstOrderAbove: null,
  ipCountryMismatch: 'ipCountry',
  // The card driver supplies the funding.
  prepaidCard: null,
  orderBurst: null,
  tooManyOrders: null,
  cardDetailsMissing: null,
};

/**
 * The signals no rule switches on or off, with the words a warning uses.
 *
 * Why: decision 050: a rule's own switch is named by its label; these signals always apply when their input arrives, so the warning needs
 * a name for them.
 */
export const SIGNALS_WITHOUT_SWITCH: Readonly<Partial<Record<SignalName, string>>> = {
  prepaidCard: 'Prepaid card BIN',
  orderBurst: 'Order burst from one device',
  cardDetailsMissing: CARD_DETAILS_MISSING_SIGNAL,
};

/** Which optional inputs this installation can supply. */
export interface RiskInputSources {
  readonly ipCountry: boolean;
}

/**
 * The inputs this installation supplies.
 *
 * Why: decision 050: the visitor's country exists only when the proxy header is configured.
 *
 * @param geoipCountryHeader the configured header name (`GEOIP_COUNTRY_HEADER`, lower case), or `undefined`
 * @returns what is available
 */
export function inputSourcesOf(geoipCountryHeader: string | undefined): RiskInputSources {
  return { ipCountry: geoipCountryHeader !== undefined };
}

/** A rule or signal that has no input source, with the words to say so. */
export interface InputGap {
  readonly name: RiskRuleId | SignalName;
  readonly label: string;
  readonly reason: string;
}

const REASONS: Readonly<Record<OptionalInput, string>> = {
  ipCountry: 'No visitor country: GEOIP_COUNTRY_HEADER is not set.',
};

/**
 * Names every switched-on rule and every signal without a switch whose input this installation lacks.
 *
 * Why: decision 050: such a rule never applies; the operator must not believe it protects the shop. The rules routes do not say it, so the
 * API's boot log does.
 *
 * @param rules the stored rules
 * @param sources what this installation supplies
 * @returns the gaps: the rules in the console's order first, then the signals without a switch
 */
export function rulesWithoutInput(rules: RiskRuleSet, sources: RiskInputSources): InputGap[] {
  const gaps: InputGap[] = [];
  for (const id of RISK_RULE_IDS) {
    const needed = NEEDED_INPUT[id];
    if (rules[id].on && needed !== null && !sources[needed]) {
      gaps.push({ name: id, label: RULE_DEFINITIONS[id].label, reason: REASONS[needed] });
    }
  }
  for (const [key, label] of Object.entries(SIGNALS_WITHOUT_SWITCH) as [SignalName, string][]) {
    const needed = NEEDED_INPUT[key];
    if (needed !== null && !sources[needed]) gaps.push({ name: key, label, reason: REASONS[needed] });
  }
  return gaps;
}
