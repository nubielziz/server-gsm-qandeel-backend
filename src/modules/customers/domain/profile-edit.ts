// The name, phone and country rule of an account's profile edit, shared by the shop's own edit (PATCH /store/v1/me) and any staff edit that
// judges "changed" the same way, so both record before and after values alike.

/** The columns a profile edit may write. */
export interface ProfileColumns {
  readonly name: string;
  readonly phone: string;
  readonly country: string;
  /** The ISO code of the shown currency; a changed country re-derives it. */
  readonly currency: string | null;
}

/** The profile fields both edits share. */
export interface ProfileEditInput {
  readonly name?: string | undefined;
  readonly phone?: string | undefined;
  readonly country?: string | undefined;
}

/** What an edit changes: the columns to write and the old and new value of each changed field (the audit entry of a staff edit). */
export interface ProfileChanges {
  readonly columns: Partial<ProfileColumns>;
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
 * @param current the stored account, read under the lock
 * @param input the fields sent
 * @param derivedCurrency the currency of `input.country` (see `CustomerProfileRules.currencyFor`); read only when the country changes
 * @returns the columns to write and the before and after values of the changed fields; empty when nothing changes
 */
export function profileChanges(
  current: Pick<ProfileColumns, 'name' | 'phone' | 'country'>,
  input: ProfileEditInput,
  derivedCurrency: string | null | undefined,
): ProfileChanges {
  const columns: { -readonly [K in keyof ProfileColumns]?: ProfileColumns[K] } = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const note = (field: string, from: unknown, to: unknown) => {
    before[field] = from;
    after[field] = to;
  };
  if (input.name !== undefined && input.name !== current.name) {
    columns.name = input.name;
    note('name', current.name, input.name);
  }
  if (input.country !== undefined && input.country !== current.country) {
    columns.country = input.country;
    columns.currency = derivedCurrency ?? null;
    note('country', current.country, input.country);
  }
  if (input.phone !== undefined && input.phone !== current.phone) {
    columns.phone = input.phone;
    note('phone', current.phone, input.phone);
  }
  return { columns, before, after };
}
