// The pure rules of the alert evaluator: how a value is compared with a rule, which subject an alert belongs to, and what to do with
// a reading (fire, resolve or leave it). Feature 12b, scenario system-alert steps 3 and 10; ANSWERS system-health Q29, Q31.
import type { AlertComparator, AlertStreakKind, AlertSubjectType } from '../db/schema';

/** What an alert is about: a supplier, a queue, or the platform. */
export interface AlertSubject {
  readonly type: AlertSubjectType;
  /** The record id; `null` for the platform and for a queue (a queue has no id, B103). */
  readonly id: number | null;
  /** The name shown in the console: the supplier or queue name; `null` for the platform. */
  readonly label: string | null;
}

/** The subject of an alert about the whole platform. */
export const SYSTEM_SUBJECT: AlertSubject = { type: 'system', id: null, label: null };

/**
 * The key that makes a subject unique inside a rule (`alert_events.subject_key`).
 *
 * Why: one open alert per rule and subject (health-commissions-5); a queue has no id, so its name is part of the key.
 *
 * @param subject the subject
 * @returns `system`, `supplier:<id>`, `queue:<name>` or `<type>:<id>`
 */
export function subjectKeyOf(subject: AlertSubject): string {
  if (subject.type === 'system') return 'system';
  if (subject.type === 'queue') return `queue:${subject.label ?? ''}`;
  return `${subject.type}:${subject.id ?? 0}`;
}

/**
 * Values are compared and stored with the 4 decimals of `alert_events.value`, so a stored value reads the way it was judged.
 *
 * @param value a measured value
 * @returns the value rounded to 4 decimals
 */
export const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * Whether a value is on the bad side of a rule's threshold.
 *
 * @param comparator how the rule compares: `gt`, `gte`, `lt` or `lte`
 * @param value the measured value
 * @param threshold the rule's threshold, in the metric's unit
 * @returns true when the rule is breached
 */
export function breaches(comparator: AlertComparator, value: number, threshold: number): boolean {
  const measured = round4(value);
  switch (comparator) {
    case 'gt':
      return measured > threshold;
    case 'gte':
      return measured >= threshold;
    case 'lt':
      return measured < threshold;
    case 'lte':
      return measured <= threshold;
  }
}

/** What the evaluator does with one reading of one subject. */
export type EvaluationDecision = 'fire' | 'resolve' | 'keep' | 'skip';

/** What {@link decide} needs to know. */
export interface ReadingFacts {
  /** The measured value; `null` is "no data" (no calls in the window). */
  readonly value: number | null;
  readonly comparator: AlertComparator;
  readonly threshold: number;
  /** Whether the subject already has an open (firing or acknowledged) alert of this rule. */
  readonly open: boolean;
  /** Whether the rule is muted right now (`muted_until` in the future). */
  readonly muted: boolean;
}

/**
 * Decides what a reading means for the alert of its subject.
 *
 * Why: scenario system-alert step 3 fires an alert when the value is over the limit, "unless the rule is muted"; step 10 closes
 * it when the value is back in range, an acknowledged alert included (acknowledging only stops the reminders, Q14). A mute stops
 * new alerts but alerts already open stay open and still resolve (Q29). No data neither fires nor resolves: nothing was measured.
 *
 * @param facts the reading and the state of the subject's alert
 * @returns `fire` (open one), `resolve` (close the open one), `keep` (still breached and already open) or `skip` (nothing to do)
 */
export function decide(facts: ReadingFacts): EvaluationDecision {
  if (facts.value === null || !Number.isFinite(facts.value)) return 'skip';
  const breached = breaches(facts.comparator, facts.value, facts.threshold);
  if (breached) return facts.open ? 'keep' : facts.muted ? 'skip' : 'fire';
  return facts.open ? 'resolve' : 'skip';
}

/**
 * Whether a mute is still on.
 *
 * @param mutedUntil the rule's `muted_until`
 * @param now the clock's time
 * @returns true while `mutedUntil` is after `now` (a past time is not muted)
 */
export function isMuted(mutedUntil: Date | null, now: Date): boolean {
  return mutedUntil !== null && mutedUntil.getTime() > now.getTime();
}

/** How long a breached (or recovered) reading may go unseen before the stretch it belongs to is over: three evaluations of the minute tick, and more. */
export const STREAK_MAX_GAP_MS = 5 * 60_000;

/**
 * A stretch that counts as held a few seconds early.
 *
 * Why: the evaluation runs on a minute schedule with some jitter, so a rule "for 1m" seen at 10:00:00.2 and again at 10:01:00.1 has held for the
 * minute; without a tolerance it would wait for the third tick half of the time.
 */
export const HOLD_TOLERANCE_MS = 5_000;

/**
 * How long a measured metric (a rate or a percentile) must stay in range before its alert closes: three consecutive ok minutes.
 *
 * Why: RULES health 8 and scenario system-alert step 10: "the checks return ok for three consecutive minutes, so the alert closes and the resolved
 * message goes out". The rule's own window only decides when the alert fires, so a rate that dips under the limit for one tick does not close it.
 */
export const RECOVERY_SECONDS = 180;

/**
 * How long a firing alert waits before its message is repeated, until a staff member acknowledges it.
 *
 * Why: RULES health 6 and scenario system-alert step 4 say "after the reminder interval" and name none; 30 minutes is the lead's default, so a
 * night alert pages every half hour and an acknowledged one never again.
 */
export const REMINDER_INTERVAL_MS = 30 * 60_000;

/**
 * Which reminder of a firing alert is due.
 *
 * Why: the reminders are counted from the moment the alert fired, in whole intervals, and the round is part of the notification's dedupe key, so an
 * evaluation that runs every minute (or twice at once) makes one message per round, and a worker that was down for hours sends one reminder, not
 * one for each interval it missed.
 *
 * @param startedAt when the alert fired
 * @param now the clock's time
 * @returns 0 until the first interval has passed, then 1, 2, 3 ...
 */
export function reminderRound(startedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / REMINDER_INTERVAL_MS));
}

/** A stretch of evaluations in which a rule's condition held for one subject (a row of `alert_streaks`). */
export interface Streak {
  /** `breach`: the value was on the bad side; `clear`: it was back in range (only kept for an open alert). */
  readonly kind: AlertStreakKind;
  /** The rule's metric, comparator and threshold when it started, see {@link conditionOf}. */
  readonly condition: string;
  /** The first evaluation of the stretch. */
  readonly since: Date;
  /** The last evaluation of the stretch. */
  readonly seenAt: Date;
}

/**
 * The part of a rule that decides what a reading means.
 *
 * Why: a stretch only counts while the rule judges the way it did when the stretch started; editing the metric, the comparator or the threshold
 * starts the window again (the window length itself is read fresh, so shortening it takes effect at once).
 *
 * @param rule the rule's metric, comparator and threshold (a numeric string or a number)
 * @returns a text that is equal for two rules that judge alike
 */
export function conditionOf(rule: {
  readonly metric: string;
  readonly comparator: AlertComparator;
  readonly threshold: string | number;
}): string {
  return `${rule.metric}|${rule.comparator}|${Number(rule.threshold)}`;
}

/** What {@link judgeHeld} needs to know. */
export interface HeldFacts extends ReadingFacts {
  /** The rule's window: how long a breach (or a recovery) has to hold. */
  readonly windowSeconds: number;
  /** The stretch the subject has now, if any. */
  readonly streak: Streak | null;
  /** {@link conditionOf} for the rule as it is now. */
  readonly condition: string;
  /** The clock's time of this evaluation. */
  readonly now: Date;
}

/** What {@link judgeHeld} decided: the action, and the stretch to keep for the next evaluation (`null`: none, delete it). */
export interface HeldJudgement {
  readonly decision: EvaluationDecision;
  readonly streak: Streak | null;
}

/**
 * Extends or starts the stretch of the subject for this reading.
 *
 * @param facts the reading and the subject's stretch
 * @param kind `breach` when the value is on the bad side, `clear` when it is back in range
 * @returns the stretch to keep: the old one, seen again now, when it is of the same kind and condition and was seen recently, else a new one that starts now
 */
function extendStretch(facts: HeldFacts, kind: AlertStreakKind): Streak {
  const prior = facts.streak;
  const continues =
    prior !== null &&
    prior.kind === kind &&
    prior.condition === facts.condition &&
    facts.now.getTime() - prior.seenAt.getTime() <= STREAK_MAX_GAP_MS;
  return { kind, condition: facts.condition, since: continues ? prior.since : facts.now, seenAt: facts.now };
}

/** Whether a stretch has lasted a number of seconds (a few seconds early counts, see {@link HOLD_TOLERANCE_MS}). */
const lasted = (streak: Streak, now: Date, seconds: number): boolean =>
  now.getTime() - streak.since.getTime() + HOLD_TOLERANCE_MS >= seconds * 1000;

/**
 * Decides what a reading of the moment means when the rule's window has to be held.
 *
 * Why: a balance, a queue age, a count or a usage is not measured over the window, so the window is a promise about time: the console prints the
 * rule as "> 20 for 5m" and the map's step 10 closes an alert after three consecutive good minutes. A breach opens an alert only after every
 * evaluation of the whole window saw it (a spike of one minute pages nobody), and a recovery closes it only after every evaluation of the whole
 * window saw the value in range (a value hovering at the threshold does not open and close an alert on each crossing). A reading that is missing
 * breaks the stretch, because nothing says the condition held at that moment. A mute keeps the stretch running (the alert opens when the mute ends
 * if the breach is still on) but opens nothing.
 *
 * @param facts the reading, the state of the subject's alert and its stretch
 * @returns the action and the stretch to store (`null` when the next evaluation starts from nothing)
 */
export function judgeHeld(facts: HeldFacts): HeldJudgement {
  const { value, now } = facts;
  if (value === null || !Number.isFinite(value)) return { decision: 'skip', streak: null };
  const breached = breaches(facts.comparator, value, facts.threshold);
  const streak = extendStretch(facts, breached ? 'breach' : 'clear');
  const held = lasted(streak, now, facts.windowSeconds);
  if (breached) {
    // An open alert needs no stretch: it stays open until the recovery has held.
    if (facts.open) return { decision: 'keep', streak: null };
    return held && !facts.muted ? { decision: 'fire', streak: null } : { decision: 'skip', streak };
  }
  if (!facts.open) return { decision: 'skip', streak: null };
  return held ? { decision: 'resolve', streak: null } : { decision: 'keep', streak };
}

/**
 * Decides what a measured reading (a rate or a percentile over the rule's window) means for the alert of its subject.
 *
 * Why: RULES health 8 and scenario system-alert step 10: a measured breach fires at once (the window is already part of the measurement), but the
 * alert closes only after {@link RECOVERY_SECONDS} of consecutive ok evaluations, so a rate that is back under the limit for one tick, and over it
 * again the next, does not close and reopen the alert and page twice. The stretch of ok evaluations is the `clear` row of `alert_streaks`; a reading
 * that is missing breaks it, like for the readings of the moment.
 *
 * @param facts the reading, the state of the subject's alert and its stretch
 * @returns the action and the `clear` stretch to store (`null` when there is none to keep)
 */
export function judgeMeasured(facts: HeldFacts): HeldJudgement {
  const { value, now } = facts;
  if (value === null || !Number.isFinite(value)) return { decision: 'skip', streak: null };
  if (breaches(facts.comparator, value, facts.threshold)) return { decision: decide(facts), streak: null };
  if (!facts.open) return { decision: 'skip', streak: null };
  const streak = extendStretch(facts, 'clear');
  return lasted(streak, now, RECOVERY_SECONDS) ? { decision: 'resolve', streak: null } : { decision: 'keep', streak };
}
