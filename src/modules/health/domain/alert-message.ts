// The words of an alert's messages (feature 12b, scenario system-alert steps 4 and 10, system-integrity step 2): the variables of the `alert.fired` and
// `alert.resolved` templates, written from the alert's snapshot. Pure.
import type { AlertComparator, AlertSeverity, AlertSubjectType, AlertUnit } from '../db/schema';
import type { Finding } from './integrity';
import { METRICS, isMetricKey } from './metric-registry';

/** Which message of an alert is being written. */
export type AlertMessageKind = 'fired' | 'reminder' | 'resolved';

/** What the words are made from: the alert as it was snapshotted, the value, and what the evaluator adds. */
export interface AlertMessageFacts {
  readonly ruleName: string;
  readonly severity: AlertSeverity;
  readonly metric: string;
  readonly unit: AlertUnit | null;
  /** The value that fired the alert, or the one that closed it. */
  readonly value: number;
  readonly threshold: number;
  readonly comparator: AlertComparator;
  readonly windowSeconds: number;
  readonly startedAt: Date;
  readonly subjectType: AlertSubjectType;
  readonly subjectLabel: string | null;
  /** A sentence the evaluator knows and the snapshot does not: the accounts of a ledger mismatch, why an alert closed. */
  readonly detail: string | null;
}

/**
 * Writes a number with its unit the way a person reads it.
 *
 * @param value the number (at most 2 decimals are kept, trailing zeros dropped)
 * @param unit the metric's unit, or `null` for none
 * @returns `25%`, `1200 ms`, `90 s`, `12/min`, `3 bytes` or the bare number
 */
export function formatAmount(value: number, unit: AlertUnit | null): string {
  const number = String(Math.round(value * 100) / 100);
  switch (unit) {
    case 'percent':
      return `${number}%`;
    case 'ms':
      return `${number} ms`;
    case 's':
      return `${number} s`;
    case 'per_min':
      return `${number}/min`;
    case 'bytes':
      return `${number} bytes`;
    case 'count':
    case null:
      return number;
  }
}

/**
 * Writes a rule's window as a length of time.
 *
 * @param seconds the window in seconds
 * @returns `45 s`, `3 min` or `2 h` (whole units only, else seconds)
 */
export function formatWindow(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

const COMPARATOR_WORDS: Readonly<Record<AlertComparator, string>> = {
  gt: 'above',
  gte: 'at or above',
  lt: 'below',
  lte: 'at or below',
};

/**
 * Names what an alert is about.
 *
 * @param type the subject type
 * @param label the supplier's or queue's name, or `null`
 * @returns `Supplier <name>`, `Queue <name>`, or `Platform` for an alert about the whole system
 */
export function subjectText(type: AlertSubjectType, label: string | null): string {
  if (label === null || label === '') return 'Platform';
  if (type === 'supplier') return `Supplier ${label}`;
  if (type === 'queue') return `Queue ${label}`;
  return label;
}

/** `2026-11-07 10:00 UTC`. */
const utcMinute = (at: Date): string => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * The short detail of a message.
 *
 * @param kind which message
 * @param facts the alert
 * @param round the reminder number (1, 2, ...) for a reminder
 * @returns the limit and window for a fired alert, the time it has been firing for a reminder, "back in range" for a recovery, then the evaluator's own sentence
 */
function detailText(kind: AlertMessageKind, facts: AlertMessageFacts, round: number): string {
  const threshold = formatAmount(facts.threshold, facts.unit);
  // The mismatch count is the outcome of a run, not a stretch of time: naming the rule's window for it would mislead.
  const window =
    isMetricKey(facts.metric) && METRICS[facts.metric].window === 'run'
      ? ''
      : ` over ${formatWindow(facts.windowSeconds)}`;
  const base =
    kind === 'fired'
      ? `The limit is ${COMPARATOR_WORDS[facts.comparator]} ${threshold}${window}.`
      : kind === 'reminder'
        ? `Reminder ${round}: still firing since ${utcMinute(facts.startedAt)} and not acknowledged.`
        : facts.detail === null
          ? 'The value is back in range.'
          : '';
  return [base, facts.detail ?? ''].filter((part) => part !== '').join(' ');
}

/**
 * The values of the placeholders of an alert's message.
 *
 * Why: the `alert.fired` and `alert.resolved` events (platform registry) share one set of variables: the rule, the severity, the metric, the value
 * against the limit with the unit, the subject and a short detail. The numbers come from the snapshot taken when the alert fired, so a rule edited
 * since does not change what an old alert says.
 *
 * @param kind `fired` (the first message), `reminder` (a repeat of it) or `resolved`
 * @param facts the alert and the value
 * @param round the reminder number, from 1 (ignored for the other kinds)
 * @returns the variables, all text
 */
export function messageVariables(
  kind: AlertMessageKind,
  facts: AlertMessageFacts,
  round = 0,
): Record<'ruleName' | 'severity' | 'metric' | 'value' | 'threshold' | 'subject' | 'detail', string> {
  return {
    ruleName: facts.ruleName,
    severity: facts.severity,
    metric: facts.metric,
    value: formatAmount(facts.value, facts.unit),
    threshold: formatAmount(facts.threshold, facts.unit),
    subject: subjectText(facts.subjectType, facts.subjectLabel),
    detail: detailText(kind, facts, round),
  };
}

/**
 * Names the accounts of a ledger mismatch for the message (scenario system-integrity step 2: "the account and the difference").
 *
 * @param findings the findings of the `accounts_match_lines` check (at most 20 are stored)
 * @param count how many accounts differ in all
 * @returns `Wallet · Zain Mobile Hub differs by 5.0000.`, with `(and 2 more)` when more than one account differs; empty when no account is named
 */
export function ledgerDetail(findings: readonly Finding[], count: number): string {
  const first = findings[0];
  if (first === undefined) return '';
  const more = count > 1 ? ` (and ${count - 1} more)` : '';
  return `${first.label} differs by ${first.difference ?? 'an unknown amount'}${more}.`;
}
