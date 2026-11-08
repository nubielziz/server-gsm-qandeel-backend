// How an erased IMEI is shown (feature 18, RESOLUTIONS b2c-4): the TAC that is still public, then bullets for the rest.
// Pure, no database.

/** The mask character the console prints for the digits that are gone. */
export const IMEI_MASK_CHAR = '•';

/** An IMEI has 15 digits. */
export const IMEI_LENGTH = 15;

/**
 * The text that stands for an IMEI whose digits were erased.
 *
 * Why: RESOLUTIONS b2c-4: after the retention job or an anonymization the staff log keeps the device (the TAC) and no longer the
 * serial part: the TAC followed by bullets up to 15 characters, or 15 bullets when the TAC is not in the catalogue.
 *
 * @param tac the 8-digit TAC of the check, or `null` when it is not in the catalogue
 * @returns for example `35389011•••••••`
 */
export function maskedImei(tac: string | null): string {
  const head = tac ?? '';
  return head + IMEI_MASK_CHAR.repeat(Math.max(0, IMEI_LENGTH - head.length));
}

/**
 * Cuts a stored main input of an order to the TAC and a mask when it is an IMEI.
 *
 * Why: anonymization keeps the order but not the device number (map: "anonymize the name, email and IMEI"; the demo keeps the first
 * 8 digits). A main input that is not an IMEI (a serial, a file name) is personal in the same way and has no public part, so it
 * is erased to `null`.
 *
 * @param input `orders.imei`: the main input of the order
 * @returns the masked IMEI, or `null` when there is nothing to keep
 */
export function erasedMainInput(input: string | null): string | null {
  if (input === null || input === '') return input;
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{15}$/.test(digits) ? maskedImei(digits.slice(0, 8)) : null;
}
