// The delivery time text of a supplier service as minutes (resolution orders-suppliers-10): used when an import creates a service.

const UNIT_MINUTES: Readonly<Record<string, number>> = {
  min: 1,
  mins: 1,
  minute: 1,
  minutes: 1,
  h: 60,
  hr: 60,
  hrs: 60,
  hour: 60,
  hours: 60,
  d: 1440,
  day: 1440,
  days: 1440,
};

/**
 * Reads a supplier's delivery time text as an SLA in minutes.
 *
 * Why: orders-suppliers-10 (case-insensitive): `instant` is 5; `N min(utes)` is N; `N[-M] hour(s)` is the upper bound times 60;
 * `N[-M] day(s)` the upper bound times 1440. Anything else, or a result of 0, uses the fallback (the setting
 * `catalog.importDefaultSlaMinutes`), a long one on purpose so an imported service is not past its SLA by a guess.
 *
 * @param text the supplier's `TIME` text
 * @param fallback the SLA to use when the text cannot be read
 * @returns the SLA in minutes (at least 1)
 */
export function slaMinutesOf(text: string, fallback: number): number {
  const value = text.trim().toLowerCase();
  if (value.startsWith('instant')) return 5;
  const match = /^(\d+)\s*(?:-\s*(\d+))?\s*([a-z]+)\b/.exec(value);
  const unit = match?.[3] === undefined ? undefined : UNIT_MINUTES[match[3]];
  if (!match || unit === undefined) return fallback;
  const bound = Number(match[2] ?? match[1]);
  const minutes = bound * unit;
  return Number.isSafeInteger(minutes) && minutes > 0 ? minutes : fallback;
}
