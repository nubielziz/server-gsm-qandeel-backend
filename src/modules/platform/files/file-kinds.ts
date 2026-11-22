// What kind of record uses a stored file, and the read permission each kind adds to a staff download (decision 047).
// Pure: the file repository reads which records use a file, this file turns that into permissions.

/**
 * The kinds of record that use a stored file, in the order their permissions are checked.
 *
 * Why: decision 047: a staff download served every kind of file under `files:read`; each kind now also needs the read permission of the
 * pages that show it.
 */
export const FILE_KINDS = [
  'identity_document', // a KYC submission lists it
  'payment_proof', // a payment's receipt (merchant or customer top-up)
  'dispute_evidence',
  'order_file', // an order's input or result
  'invoice_document',
  'ticket_attachment',
  'data_export',
] as const;

/** One kind of record that uses a file. */
export type FileKind = (typeof FILE_KINDS)[number];

/**
 * The read permission a staff download of a file of each kind needs besides `files:read`.
 *
 * Why: decision 047: the permission of the page that lists the record (`kyc:read` lists KYC submissions, `payments:read` the payments, …).
 */
export const FILE_KIND_PERMISSIONS: Readonly<Record<FileKind, string>> = {
  identity_document: 'kyc:read',
  payment_proof: 'payments:read',
  dispute_evidence: 'disputes:read',
  order_file: 'orders:read',
  invoice_document: 'invoices:read',
  ticket_attachment: 'support:read',
  data_export: 'customers:privacy',
};

/**
 * The kinds whose every staff download writes an audit row.
 *
 * Why: decision 047: who opened which identity document or payment proof is in the audit log of the merchant or payment, whichever route
 * the staff member opened the file from.
 */
export const AUDITED_FILE_KINDS: readonly FileKind[] = ['identity_document', 'payment_proof'];

/**
 * Picks the kinds of a file whose opening is audited: the one rule every staff route that opens files applies.
 *
 * @param kinds the kinds of record that use the file (any order, duplicates allowed)
 * @returns the audited ones, in {@link FILE_KINDS} order, each once; empty when opening the file leaves no audit row
 */
export function auditedKindsOf(kinds: readonly FileKind[]): FileKind[] {
  return FILE_KINDS.filter((kind) => kinds.includes(kind) && AUDITED_FILE_KINDS.includes(kind));
}

/**
 * The permissions a staff download of a file of these kinds needs besides `files:read`.
 *
 * @param kinds the kinds of record that use the file (any order, duplicates allowed)
 * @returns one permission per kind, in {@link FILE_KINDS} order, each once
 */
export function permissionsForFile(kinds: readonly FileKind[]): string[] {
  return FILE_KINDS.filter((kind) => kinds.includes(kind)).map((kind) => FILE_KIND_PERMISSIONS[kind]);
}

/**
 * What uses a file: the answer of `fileReferencesOf`.
 *
 * Why: decision 047: the newest KYC submission and the newest payment name the audit rows, the other kinds are yes or no.
 */
export interface FileReferences {
  /** The newest KYC submission that lists the file, with its merchant (`clientName` is empty when the merchant row is gone). */
  readonly kyc?: { readonly submissionId: number; readonly clientId: number; readonly clientName: string };
  /** The newest payment whose receipt is the file. */
  readonly paymentId?: number;
  readonly disputeEvidence: boolean;
  readonly orderFile: boolean;
  readonly invoiceDocument: boolean;
  readonly ticketAttachment: boolean;
  readonly dataExport: boolean;
}

/**
 * Names the kinds of record that use a file.
 *
 * @param refs what uses the file
 * @returns the kinds, in {@link FILE_KINDS} order
 */
export function fileKindsOf(refs: FileReferences): FileKind[] {
  const present: Record<FileKind, boolean> = {
    identity_document: refs.kyc !== undefined,
    payment_proof: refs.paymentId !== undefined,
    dispute_evidence: refs.disputeEvidence,
    order_file: refs.orderFile,
    invoice_document: refs.invoiceDocument,
    ticket_attachment: refs.ticketAttachment,
    data_export: refs.dataExport,
  };
  return FILE_KINDS.filter((kind) => present[kind]);
}
