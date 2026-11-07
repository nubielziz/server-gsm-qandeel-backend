// Cross-row checks of the replace-all lists of a service (custom fields and option lists). Pure functions: they find the
// later occurrence of a repeated key or value, the way the console highlights it (`fields.N.key`, `options.N.value`).

/** A problem in a list, at the index of the row that caused it. */
export interface ListProblem {
  /** The dotted path the console highlights, for example `options.7.value`. */
  readonly field: string;
  readonly message: string;
}

/**
 * Finds the custom fields whose key repeats an earlier one.
 *
 * Why: `service_fields` is unique on (service, key) and the replace-all PUT names the later occurrence
 * (docs/contract/endpoints/catalog.md, PUT /admin/services/:id/fields).
 *
 * @param keys the field keys in list order, already trimmed
 * @returns one problem per repeated key, on the later row
 */
export function duplicateFieldKeys(keys: readonly string[]): ListProblem[] {
  const seen = new Set<string>();
  const problems: ListProblem[] = [];
  keys.forEach((key, index) => {
    if (seen.has(key)) problems.push({ field: `fields.${index}.key`, message: `The key ${key} is used twice.` });
    seen.add(key);
  });
  return problems;
}

/**
 * Finds the option values that repeat an earlier one in the same list.
 *
 * Why: RESOLUTIONS catalog-11: a value repeated within one list (exact match after trimming) is `422` on `options.N.value`
 * with N the later occurrence; the same value may appear in two different lists.
 *
 * @param options the options in list order, with trimmed values
 * @returns one problem per repeated value, on the later row
 */
export function duplicateOptionValues(options: ReadonlyArray<{ list: string; value: string }>): ListProblem[] {
  const seen = new Set<string>();
  const problems: ListProblem[] = [];
  options.forEach((option, index) => {
    const key = `${option.list}\u0000${option.value}`;
    if (seen.has(key)) {
      problems.push({ field: `options.${index}.value`, message: `Duplicate in the ${option.list} list` });
    }
    seen.add(key);
  });
  return problems;
}

/**
 * Tells whether a text compiles as a JavaScript regular expression.
 *
 * Why: a custom field's `regex` validates what a merchant types in the order form; one that cannot compile would fail on
 * every order, so the save refuses it. An empty text means "no pattern".
 *
 * @param pattern the pattern text
 * @returns true when it is empty or compiles
 */
export function isValidPattern(pattern: string): boolean {
  if (pattern === '') return true;
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}
