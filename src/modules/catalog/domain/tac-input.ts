// Input rules of the TAC catalog routes (catalog-7, catalog-8): the release year bounds and the wire form of an unknown year.
// Pure functions, unit-tested.
import type { FieldError } from '../../../common/errors';

/** The earliest release year a TAC entry may carry. */
export const MIN_RELEASE_YEAR = 1990;

/**
 * Checks a release year typed in a body.
 *
 * Why: catalog-8: "releaseYear optional, a 4-digit integer 1990..(current year + 1); 0 or null in a body are refused with 422
 * (the console never sends them)". The current year comes from the clock (decision 031), so the caller passes it.
 *
 * @param year the year from the request
 * @param currentYear the clock's current UTC year
 * @returns a field error, or `undefined` when the year is valid
 */
export function checkReleaseYear(year: number, currentYear: number): FieldError | undefined {
  const max = currentYear + 1;
  return Number.isInteger(year) && year >= MIN_RELEASE_YEAR && year <= max
    ? undefined
    : { field: 'releaseYear', code: 'range', message: `Enter a 4-digit year from ${MIN_RELEASE_YEAR} to ${max}.` };
}

/**
 * Writes a stored release year for the wire: an unknown year is `0`.
 *
 * Why: catalog-8: the column stays nullable, the console's type is a number and shows 0 as a dash.
 *
 * @param stored the column value
 * @returns the year, or 0 when unknown
 */
export function wireReleaseYear(stored: number | null): number {
  return stored ?? 0;
}

/**
 * Words the refusal of a TAC change that IMEI checks block.
 *
 * Why: catalog-7: `imei_checks.tac` records the TAC of the IMEI actually checked, a historical fact that a catalog edit must not
 * change, so a used TAC keeps its value.
 *
 * @param count how many IMEI checks use the old TAC
 * @param tac the old TAC
 * @returns the message of the `422` on `tac`
 */
export function tacInUseMessage(count: number, tac: string): string {
  return `${count} IMEI checks already use TAC ${tac}; add a new entry for the new TAC instead.`;
}
