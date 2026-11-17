// Pure rules of a staff edit of a merchant (feature 20): which of the three kinds of change a PATCH is, and which columns a details edit
// really changes. No I/O, so the rules are unit-tested.
import type { Client, ClientStatus } from '../db/schema';

/** The profile keys a details edit may carry. */
export const DETAIL_KEYS = [
  'name',
  'company',
  'phone',
  'country',
  'email',
  'address',
  'taxId',
  'internalNotes',
] as const;

/** One key of {@link DETAIL_KEYS}. */
export type DetailKey = (typeof DETAIL_KEYS)[number];

/** The body of `PATCH /admin/clients/:id` as the domain reads it. */
export interface ClientChangeInput {
  readonly status?: ClientStatus | undefined;
  readonly reason?: string | undefined;
  readonly groupId?: number | undefined;
  readonly name?: string | undefined;
  readonly company?: string | undefined;
  readonly phone?: string | undefined;
  readonly country?: string | undefined;
  readonly email?: string | undefined;
  readonly address?: string | undefined;
  readonly taxId?: string | undefined;
  readonly internalNotes?: string | undefined;
}

/** What kind of change a PATCH asks for. */
export type ClientChangeKind = 'status' | 'group' | 'details';

/** A field error in the shape the use cases turn into `422 VALIDATION_FAILED`. */
export interface FieldProblem {
  readonly field: string;
  readonly message: string;
}

/** The sentence of a body that mixes kinds. */
export const MIXED_CHANGE_MESSAGE = 'Send one change at a time: a status, a group or details.';

/**
 * Says which kind of change a PATCH is.
 *
 * Why: a call is one of three kinds (a status change, a group move, or details), so each has its own audit row and its own rules
 * (feature 20, plan section 4.1). A mixed body is `422` on the first key of the second kind; an empty one on `status`.
 *
 * @param input the body
 * @returns the kind, or the field error
 */
export function kindOfClientChange(input: ClientChangeInput): { kind: ClientChangeKind } | { problem: FieldProblem } {
  const present: Array<{ kind: ClientChangeKind; field: string }> = [];
  if (input.status !== undefined) present.push({ kind: 'status', field: 'status' });
  if (input.groupId !== undefined) present.push({ kind: 'group', field: 'groupId' });
  const firstDetail = DETAIL_KEYS.find((key) => input[key] !== undefined);
  if (firstDetail !== undefined) present.push({ kind: 'details', field: firstDetail });
  if (present.length === 0) return { problem: { field: 'status', message: 'Send a status, a group or details.' } };
  if (present.length > 1) return { problem: { field: present[1]!.field, message: MIXED_CHANGE_MESSAGE } };
  return { kind: present[0]!.kind };
}

/** The columns a details edit writes. */
export interface DetailColumns {
  name?: string;
  company?: string;
  phone?: string;
  country?: string;
  email?: string;
  address?: string;
  taxId?: string;
  internalNotes?: string;
}

/** The result of comparing a details edit with the stored merchant. */
export interface DetailChanges {
  /** Only the keys whose value differs from the stored one. */
  readonly columns: DetailColumns;
  /** The stored values of those keys (the audit row's `before`). */
  readonly before: Readonly<Record<string, unknown>>;
  /** The new values of those keys (the audit row's `after`). */
  readonly after: Readonly<Record<string, unknown>>;
  readonly emailChanged: boolean;
  readonly nameChanged: boolean;
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Compares a details edit with the stored merchant.
 *
 * Why: a key equal to the stored value is not a change (the console may send the whole form); the name is stored with single
 * spaces and the email lower-case, the way the invitation stores them.
 *
 * @param client the locked merchant row
 * @param input the body of the edit
 * @returns the changed keys, or the field error (a name that is empty after cleaning)
 */
export function detailChanges(client: Client, input: ClientChangeInput): DetailChanges | { problem: FieldProblem } {
  const columns: DetailColumns = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const set = <K extends DetailKey>(key: K, next: DetailColumns[K], stored: Client[K], differs: boolean) => {
    if (!differs) return;
    columns[key] = next;
    before[key] = stored;
    after[key] = next;
  };

  if (input.name !== undefined) {
    const name = collapse(input.name);
    if (name === '') return { problem: { field: 'name', message: 'Enter a name.' } };
    set('name', name, client.name, name !== client.name);
  }
  if (input.email !== undefined) {
    const email = input.email.toLowerCase();
    set('email', email, client.email, email !== client.email.toLowerCase());
  }
  if (input.company !== undefined) set('company', input.company, client.company, input.company !== client.company);
  if (input.phone !== undefined) set('phone', input.phone, client.phone, input.phone !== client.phone);
  if (input.country !== undefined) set('country', input.country, client.country, input.country !== client.country);
  if (input.address !== undefined) set('address', input.address, client.address, input.address !== client.address);
  if (input.taxId !== undefined) set('taxId', input.taxId, client.taxId, input.taxId !== client.taxId);
  if (input.internalNotes !== undefined) {
    set('internalNotes', input.internalNotes, client.internalNotes, input.internalNotes !== client.internalNotes);
  }
  return {
    columns,
    before,
    after,
    emailChanged: columns.email !== undefined,
    nameChanged: columns.name !== undefined,
  };
}
