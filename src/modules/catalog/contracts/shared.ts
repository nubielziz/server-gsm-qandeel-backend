// Field schemas shared by the catalog route contracts: amounts, percents and names as the console sends them.
import { z } from 'zod';
import { zDecimal, zMoney } from '../../../common/contract';

/** A money field that may be zero but not negative (`earnThreshold`, `depositLimit`, `minProfit`): wire `Money`. */
export const NonNegativeMoney = zMoney.refine((value) => !value.startsWith('-'), 'Must be 0 or more.');

/** A money field above zero (`basePrice`): wire `Money`. */
export const PositiveMoney = zMoney.refine(
  (value) => /[1-9]/.test(value) && !value.startsWith('-'),
  'Must be greater than zero.',
);

/**
 * A percent from 0 to 100 with at most two decimals, written as plain decimal text (`"4"`, `"2.5"`).
 *
 * Why: the group dialog sends the discount as typed; the server stores it with four decimals (`"4.0000"`) and the CHECK
 * `client_groups_amounts_check` bounds it to 0-100 (docs/contract/endpoints/catalog.md, POST /admin/client-groups).
 */
export const PercentField = zDecimal
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter a percent from 0 to 100 with at most two decimals.')
  .refine((value) => Number(value) <= 100, 'Enter a percent from 0 to 100.');

/** An id and a name, the join shape of a service row. */
export const NamedRef = z.object({ id: z.number().int().positive(), name: z.string() });
