// The pure rules of the account block, export and anonymization (feature 18, decision 064; POST /admin/clients/:id/block, GET
// /admin/clients/:id/export, POST /admin/clients/:id/anonymize): the reasons, the words an anonymized account keeps, which accounts the
// guest row of the same email belongs with, how stored inputs are cut and what an export file is called. No database.
import type { RankKind } from '../../identity';
import { erasedMainInput } from '../../risk';

/** The reasons the console's block dialog offers (customers/lib/status.ts, BLOCK_REASONS). */
export const BLOCK_REASONS = ['Chargeback or dispute', 'Card testing or fraud', 'Abuse of refunds', 'Other'] as const;

/** One value of {@link BLOCK_REASONS}. */
export type BlockReason = (typeof BLOCK_REASONS)[number];

/** The longest reason or note stored with a block. */
export const MAX_BLOCK_NOTE_LENGTH = 300;

/** The name an anonymized account keeps (the console and the demo print it). */
export const ANONYMIZED_NAME = 'Deleted account';

/**
 * The address an anonymized account keeps.
 *
 * Why: the unique email indexes must stay satisfiable, and the address of the old account is free again (ANSWERS customers Q10). The
 * pattern names the account, not a customer number: an account id and an old customer number are different things since decision 064,
 * so the old pattern `deleted-<id>@redacted.invalid` could collide with a former customer anonymized under the same number.
 *
 * @param id the account id (a guest row's id too)
 * @returns for example `deleted-account-14@redacted.invalid`
 */
export function anonymizedEmail(id: number): string {
  return `deleted-account-${id}@redacted.invalid`;
}

/**
 * The line a block adds to the account's internal notes.
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
 * The status an account goes back to when staff lift its block.
 *
 * Why: decision 046: a suspension decides who may use the account, so only a holder of `clients:security` lifts it, through the status
 * change. A block keeps the suspension it found (the suspension columns stay), so lifting the block never lifts the suspension, whoever
 * holds `clients:block`.
 *
 * @param account the suspension time of the blocked account
 * @returns `suspended` when a suspension is recorded, else `active`
 */
export function statusAfterUnblock(account: { readonly suspendedAt: Date | null }): 'active' | 'suspended' {
  return account.suspendedAt === null ? 'active' : 'suspended';
}

/**
 * Tells whether an export carries the merchant part (the merchant wallet and its statement, the API keys and the invoices).
 *
 * Why: the right of access covers every record of the account, whatever its rank is today (decision 064). A merchant rank always has the
 * part; an account that held a merchant rank before keeps its keys and its merchant invoices in the file even when its merchant wallet has
 * no lines. A merchant wallet that was opened and never used tells nothing, so it alone adds nothing.
 *
 * @param facts the rank kind today and what the merchant part holds
 * @returns true when the export lists the merchant part
 */
export function holdsMerchantPart(facts: {
  readonly rankKind: RankKind;
  readonly walletLines: number;
  readonly apiKeys: number;
  readonly merchantInvoices: number;
}): boolean {
  return facts.rankKind === 'merchant' || facts.walletLines > 0 || facts.apiKeys > 0 || facts.merchantInvoices > 0;
}

/**
 * The file name an export is offered under.
 *
 * @param id the account id
 * @returns `account-<id>.json`
 */
export function exportFilename(id: number): string {
  return `account-${id}.json`;
}

/**
 * Tells whether the guest row of an account's email belongs to the account's export and erasure.
 *
 * Why: decision 064: a person who proved their mailbox and holds a retail account may also have bought as a guest with that address
 * before. Those orders, checkouts, consents, tickets and files are theirs, so the export lists them and the erasure removes them. An
 * unproven address proves nothing about who typed it, and a merchant rank has no guest history of its own: neither touches the guest row.
 *
 * @param account the account's rank kind, whether it has a login and when its email was proven
 * @returns true for a retail account with a login and a proven email
 */
export function coversGuestRow(account: {
  readonly rankKind: RankKind;
  readonly hasAccount: boolean;
  readonly emailVerifiedAt: Date | null;
}): boolean {
  return account.rankKind === 'retail' && account.hasAccount && account.emailVerifiedAt !== null;
}

/**
 * Words the refusal of an erasure that finds an open checkout or a pending payment on the guest row.
 *
 * @param open what is still open: a checkout, a payment or both
 * @returns the sentence for the `409 CONFLICT` detail
 */
export function guestRowOpenText(open: { readonly checkouts: number; readonly payments: number }): string {
  const parts: string[] = [];
  if (open.checkouts > 0) parts.push(open.checkouts === 1 ? 'an open checkout' : `${open.checkouts} open checkouts`);
  if (open.payments > 0)
    parts.push(open.payments === 1 ? 'a payment still pending' : `${open.payments} payments still pending`);
  return `The guest orders placed with this email have ${parts.join(' and ')}. Wait for them to finish or expire first.`;
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
