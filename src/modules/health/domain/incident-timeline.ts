// The pure rules of an incident's life: the line the server writes when an incident is declared, when its status changes or when staff
// add an update, and the rule for closing it. Feature 12b, scenario system-alert steps 7 and 11; ANSWERS system-health Q8, Q31, B104.
import type { IncidentStatus } from '../db/schema';

/** A staff member as a timeline line names them (a snapshot, so a rename never rewrites history). */
export interface TimelineActor {
  readonly id: number;
  readonly name: string;
}

/** One line of an incident's timeline (`incidents.timeline`, the console's `IncidentTimelineEntry`). */
export interface TimelineLine {
  readonly at: string;
  readonly status: IncidentStatus;
  readonly text: string;
  readonly by: TimelineActor | null;
}

/** The first line of every incident (scenario system-alert step 7). */
export const DECLARED_TEXT = 'Incident declared. We are investigating.';

/** The line written when staff change the status without writing an update. */
export const DEFAULT_TEXT: Readonly<Record<IncidentStatus, string>> = {
  investigating: 'Back to investigating.',
  identified: 'The cause is identified.',
  monitoring: 'A fix is in place; watching it.',
  resolved: 'The incident is resolved.',
};

/** The fewest characters a root cause may have: closing an incident is a decision with a reason (ANSWERS Q8). */
export const MIN_ROOT_CAUSE_LENGTH = 10;

/**
 * The timeline of a new incident.
 *
 * @param at the clock's time
 * @param by the staff member who declared it
 * @returns one `investigating` line
 */
export function declaredTimeline(at: Date, by: TimelineActor | null): TimelineLine[] {
  return [{ at: at.toISOString(), status: 'investigating', text: DECLARED_TEXT, by }];
}

/** What staff changed in one update of an incident (the fields that decide whether a line is written). */
export interface TimelineChange {
  readonly status?: IncidentStatus | undefined;
  /** The update text staff wrote; trimmed, empty means none. */
  readonly update?: string | undefined;
}

/** The outcome of {@link nextLine}. */
export interface NextLine {
  /** The status after the change. */
  readonly status: IncidentStatus;
  /** The line to append, or `null` when nothing changed the timeline. */
  readonly line: TimelineLine | null;
  /** True when this change closes the incident. */
  readonly closes: boolean;
}

/**
 * Works out the timeline line of an update.
 *
 * Why: "a status change or a non-empty update appends one timeline line {at now, status, text = update or a default sentence, by
 * staff}; `resolved` also sets resolvedAt, resolvedBy and root_cause" (endpoint doc). The closing update is how "the action taken"
 * is kept (B104): it becomes the `resolved` line.
 *
 * @param current the incident's status now
 * @param change the new status and the update text, if any
 * @param at the clock's time
 * @param by the staff member
 * @returns the status after the change and the line to append (`null` for a change of title, severity, summary or components only)
 */
export function nextLine(
  current: IncidentStatus,
  change: TimelineChange,
  at: Date,
  by: TimelineActor | null,
): NextLine {
  const status = change.status ?? current;
  const update = change.update?.trim() ?? '';
  if (status === current && update === '') return { status, line: null, closes: false };
  return {
    status,
    line: { at: at.toISOString(), status, text: update === '' ? DEFAULT_TEXT[status] : update, by },
    closes: status === 'resolved' && current !== 'resolved',
  };
}

/**
 * Whether an incident can be closed with this root cause.
 *
 * @param bodyRootCause the root cause sent with the close, if any
 * @param storedRootCause the root cause already saved on the incident, if any
 * @returns true when the sent text (or, when none was sent, the saved one) has at least {@link MIN_ROOT_CAUSE_LENGTH} characters
 */
export function hasRootCause(bodyRootCause: string | undefined, storedRootCause: string | null): boolean {
  const text = (bodyRootCause ?? storedRootCause ?? '').trim();
  return text.length >= MIN_ROOT_CAUSE_LENGTH;
}
