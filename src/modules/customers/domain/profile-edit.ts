// The name, phone and country rule of a customer's profile edit, shared by the staff edit (PATCH /admin/customers/:id) and the
// customer's own edit (PATCH /store/v1/me), so both judge "changed" and record before and after values alike.
import type { Customer } from '../db/schema';

/** The profile fields both edits share. */
export interface ProfileEditInput {
  readonly name?: string | undefined;
  readonly phone?: string | undefined;
  readonly country?: string | undefined;
}

/** What an edit changes: the columns to write and the old and new value of each changed field (the audit entry of a staff edit). */
export interface ProfileChanges {
  readonly columns: Partial<Customer>;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
}

/**
 * Works out which of name, country and phone really change.
 *
 * Why: ANSWERS customers Q8 and the audit rule of the staff edit: a field sent with the stored value is not a change; a changed
 * country sets the currency derived for it (`null` only when USD itself is missing from `currencies`). The order of the notes (name,
 * country, phone) is the order of the audit entry.
 *
 * @param customer the stored row, read under the lock
 * @param input the fields sent
 * @param derivedCurrency the currency of `input.country` (see `CustomerProfileRules.currencyFor`); read only when the country changes
 * @returns the columns to write and the before and after values of the changed fields; empty when nothing changes
 */
export function profileChanges(
  customer: Pick<Customer, 'name' | 'phone' | 'country'>,
  input: ProfileEditInput,
  derivedCurrency: string | null | undefined,
): ProfileChanges {
  const columns: Partial<Customer> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const note = (field: string, from: unknown, to: unknown) => {
    before[field] = from;
    after[field] = to;
  };
  if (input.name !== undefined && input.name !== customer.name) {
    columns.name = input.name;
    note('name', customer.name, input.name);
  }
  if (input.country !== undefined && input.country !== customer.country) {
    columns.country = input.country;
    columns.currency = derivedCurrency ?? null;
    note('country', customer.country, input.country);
  }
  if (input.phone !== undefined && input.phone !== customer.phone) {
    columns.phone = input.phone;
    note('phone', customer.phone, input.phone);
  }
  return { columns, before, after };
}
