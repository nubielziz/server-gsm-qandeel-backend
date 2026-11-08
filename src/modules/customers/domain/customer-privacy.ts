// The pure rules of the customer block, export and anonymization (feature 18, stage 18; POST /admin/customers/:id/block, GET
// /admin/customers/:id/export, POST /admin/customers/:id/anonymize): the reasons, the words an anonymized customer keeps, how stored
// inputs are cut and what an export file is called. No database.
import { erasedMainInput } from '../../risk';

/** The reasons the console's block dialog offers (customers/lib/status.ts, BLOCK_REASONS). */
export const BLOCK_REASONS = ['Chargeback or dispute', 'Card testing or fraud', 'Abuse of refunds', 'Other'] as const;

/** One value of {@link BLOCK_REASONS}. */
export type BlockReason = (typeof BLOCK_REASONS)[number];

/** The longest reason or note stored with a block. */
export const MAX_BLOCK_NOTE_LENGTH = 300;

/** The name an anonymized customer keeps (the console and the demo print it). */
export const ANONYMIZED_NAME = 'Deleted customer';

/**
 * The address an anonymized customer keeps.
 *
 * Why: the unique email index must stay satisfiable, and the address of the old customer is free again (ANSWERS customers Q10).
 *
 * @param id the customer id
 * @returns for example `deleted-14@redacted.invalid`
 */
export function anonymizedEmail(id: number): string {
  return `deleted-${id}@redacted.invalid`;
}

/**
 * The line a block adds to the customer's internal notes.
 *
 * Why: B48: the demo overwrote the notes with the reason; the accepted proposal appends, so earlier notes survive.
 *
 * @param reason the block reason
 * @returns the line to append
 */
export function blockNoteLine(reason: string): string {
  return `Blocked: ${reason}`;
}

/**
 * Appends a line to a notes text.
 *
 * @param notes the existing notes (may be empty)
 * @param line the line to add
 * @returns the notes with the line on a new line
 */
export function appendNote(notes: string, line: string): string {
  return notes.trim() === '' ? line : `${notes.replace(/\s+$/, '')}\n${line}`;
}

/**
 * The file name an export is offered under.
 *
 * @param id the customer id
 * @returns `customer-<id>.json`, the name the console falls back to
 */
export function exportFilename(id: number): string {
  return `customer-${id}.json`;
}

/**
 * Cuts the IMEI-looking values of a form's inputs to the TAC and a mask.
 *
 * Why: B50: anonymization keeps the order and the checkout but not the device number; a value that is a 15-digit IMEI is masked, any
 * other value is left as it is (the service cannot tell which free text is personal).
 *
 * @param inputs the stored custom field values
 * @returns a copy with the IMEI-looking strings masked
 */
export function scrubInputs(inputs: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(inputs).map(([key, value]) => [
      key,
      typeof value === 'string' && /^\d{15}$/.test(value.replace(/[\s-]/g, '')) ? erasedMainInput(value) : value,
    ]),
  );
}
