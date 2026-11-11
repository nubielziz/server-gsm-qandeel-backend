// The quantity rule of a service (feature 25): the one pure function that decides which smallest, largest and pack sizes a service
// may be saved with. The admin use cases and the supplier import are the only writers of the three columns.
import type { FieldError } from '../../../common/errors';

/** The largest quantity (and pack size) a service may sell: the limit the order contracts already use. */
export const MAX_QUANTITY = 100_000;

/** The most pack sizes one service may list. */
export const MAX_QTY_OPTIONS = 50;

/** What a service sells per order: a range `minQty..maxQty`, or, when `qtyOptions` is not empty, only those pack sizes. */
export interface QuantityRule {
  readonly minQty: number;
  readonly maxQty: number;
  readonly qtyOptions: number[];
}

/** The keys of a request that change the rule; a key left out (`undefined`) stays as it is. */
export interface QuantityChange {
  readonly minQty?: number | undefined;
  readonly maxQty?: number | undefined;
  readonly qtyOptions?: readonly number[] | undefined;
}

/** The result of applying a change: the complete rule to store, or every problem with its field. */
export type QuantityOutcome = { ok: true; rule: QuantityRule } | { ok: false; errors: FieldError[] };

const isWhole = (value: number): boolean => Number.isInteger(value) && value >= 1 && value <= MAX_QUANTITY;

/**
 * The first pack that is not a whole number from 1 to 100000, or the first repeated one: one problem for the field
 * `qtyOptions`, because the console shows one message under its one input.
 */
function packProblem(packs: readonly number[]): FieldError | undefined {
  const bad = packs.find((pack) => !isWhole(pack));
  if (bad !== undefined) {
    return {
      field: 'qtyOptions',
      code: 'invalid_pack',
      message: `Pack sizes are whole numbers from 1 to ${MAX_QUANTITY}; ${bad} is not.`,
    };
  }
  const seen = new Set<number>();
  for (const pack of packs) {
    if (seen.has(pack)) {
      return { field: 'qtyOptions', code: 'duplicate_pack', message: `The pack size ${pack} is repeated.` };
    }
    seen.add(pack);
  }
  return undefined;
}

/**
 * Works out the rule a service has after a change is applied to its current rule.
 *
 * Why: a service sells either a range or fixed packs (feature 25, B212). With packs the server stores `minQty` as the smallest
 * and `maxQty` as the largest pack, so the default quantity of an order without one, the "in stock" test and Dhru's MINQNT and
 * MAXQNT always agree with what placement accepts. Without packs `minQty..maxQty` must be a valid range. Every problem of the
 * request is returned together.
 *
 * @param current the rule the service has now (`{ 1, 1, [] }` for a new service)
 * @param change the keys the request sent; a key left out keeps its stored value, `qtyOptions: []` clears the packs
 * @returns the rule to store (packs sorted ascending), or the field errors (`invalid_pack`, `duplicate_pack` on `qtyOptions`;
 *   `below_min` on `maxQty`; `above_max` on `minQty`; `packs_set` on `minQty` or `maxQty`)
 */
export function resolveQuantityRule(current: QuantityRule, change: QuantityChange): QuantityOutcome {
  const errors: FieldError[] = [];
  const sent = change.qtyOptions;
  if (sent !== undefined) {
    const problem = packProblem(sent);
    if (problem) errors.push(problem);
  }
  if (errors.length > 0) return { ok: false, errors };

  const packs = [...(sent === undefined ? current.qtyOptions : sent)].sort((a, b) => a - b);
  if (packs.length > 0) {
    const min = packs[0]!;
    const max = packs[packs.length - 1]!;
    if (change.minQty !== undefined && change.minQty !== min) {
      errors.push({
        field: 'minQty',
        code: 'packs_set',
        message: `This service sells fixed packs, so its smallest quantity is the smallest pack (${min}). Clear the packs to set a range.`,
      });
    }
    if (change.maxQty !== undefined && change.maxQty !== max) {
      errors.push({
        field: 'maxQty',
        code: 'packs_set',
        message: `This service sells fixed packs, so its largest quantity is the largest pack (${max}). Clear the packs to set a range.`,
      });
    }
    return errors.length > 0
      ? { ok: false, errors }
      : { ok: true, rule: { minQty: min, maxQty: max, qtyOptions: packs } };
  }

  const minQty = change.minQty ?? current.minQty;
  const maxQty = change.maxQty ?? current.maxQty;
  if (maxQty < minQty) {
    if (change.maxQty === undefined && change.minQty !== undefined) {
      errors.push({
        field: 'minQty',
        code: 'above_max',
        message: `The smallest quantity cannot be above the largest (${maxQty}).`,
      });
    } else {
      errors.push({
        field: 'maxQty',
        code: 'below_min',
        message: `The largest quantity cannot be below the smallest (${minQty}).`,
      });
    }
    return { ok: false, errors };
  }
  return { ok: true, rule: { minQty, maxQty, qtyOptions: [] } };
}

/**
 * Lists the problems of a complete rule.
 *
 * Why: the supplier import writes a rule it read from a supplier; it must be one the admin routes could have saved (feature 25).
 *
 * @param rule the rule to check
 * @returns one text per problem; empty means the rule may be stored (limits, `min <= max`, whole unique ascending packs, and
 *   with packs `minQty` the smallest and `maxQty` the largest)
 */
export function quantityRuleProblems(rule: QuantityRule): string[] {
  const problems: string[] = [];
  if (!isWhole(rule.minQty)) problems.push(`minQty ${rule.minQty} is not a whole number from 1 to ${MAX_QUANTITY}`);
  if (!isWhole(rule.maxQty)) problems.push(`maxQty ${rule.maxQty} is not a whole number from 1 to ${MAX_QUANTITY}`);
  if (rule.maxQty < rule.minQty) problems.push(`maxQty ${rule.maxQty} is below minQty ${rule.minQty}`);
  if (rule.qtyOptions.length > MAX_QTY_OPTIONS) problems.push(`more than ${MAX_QTY_OPTIONS} pack sizes`);
  const packs = packProblem(rule.qtyOptions);
  if (packs) problems.push(packs.message);
  if (rule.qtyOptions.some((pack, index) => index > 0 && pack < rule.qtyOptions[index - 1]!)) {
    problems.push('pack sizes are not ascending');
  }
  if (rule.qtyOptions.length > 0) {
    const min = Math.min(...rule.qtyOptions);
    const max = Math.max(...rule.qtyOptions);
    if (rule.minQty !== min) problems.push(`minQty ${rule.minQty} is not the smallest pack (${min})`);
    if (rule.maxQty !== max) problems.push(`maxQty ${rule.maxQty} is not the largest pack (${max})`);
  }
  return problems;
}
