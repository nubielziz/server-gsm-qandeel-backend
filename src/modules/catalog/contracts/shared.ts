// Field schemas shared by the catalog route contracts: amounts, percents and names as the console sends them.
import { z } from 'zod';
import { zDecimal, zMoney } from '../../../common/contract';

/** A money field that may be zero but not negative (`depositLimit`, `minProfit`): wire `Money`. */
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

/**
 * What each custom field type checks: the description of `fieldType` on the catalog's field reads and writes (admin and portal).
 *
 * Why: decisions 073 and 076: staff choose the type of a field and the server judges the value by it on every surface (the portal, Dhru
 * and the shop); the order forms show the same rules.
 */
export const FIELD_TYPE_DESCRIPTION =
  'Each value is trimmed, read into its stored form and judged by its type, on any service type (decisions 073 and 076). ' +
  '`imei`: one IMEI, spaces and dashes removed, 15 digits with a valid Luhn check digit (else `422 INVALID_IMEI`, code ' +
  '`invalid_imei` on `inputs.<key>`). `imei_bulk`: 1 to 30 IMEIs split on line breaks, commas and semicolons and stored one per ' +
  'line; still one order at one price (a bad line is `422 INVALID_IMEI`, `invalid_imei` "Line N ..."; more than 30 ' +
  '`too_many_imeis`, a repeat `duplicate_imei`). The other check types answer `422 VALIDATION_FAILED` with `invalid_<type>`: ' +
  '`imeisv` 16 digits; `serial` 5 to 30 letters and digits (stored upper-case); `iccid` 18 to 22 digits starting with 89; `eid` 32 ' +
  'digits; `meid` 14 or 15 hexadecimal characters or 18 digits; `ecid` an optional `0x` and 8 to 16 hexadecimal characters, or 8 ' +
  'to 20 digits; `mac_address` 12 hexadecimal characters, alone or in pairs by `:` or `-` or in fours by `.`, stored as ' +
  '`AA:BB:CC:DD:EE:FF`; `mi_lock_code` 6 to 64 letters, digits and dashes; `box_sn` 4 to 32 letters, digits and dashes (stored ' +
  'upper-case). `text`, `number`, `select` and `textarea` are stored as sent.';

/** An id and a name, the join shape of a service row. */
export const NamedRef = z.object({ id: z.number().int().positive(), name: z.string() });

/**
 * A percent for a pricing rule: plain decimal text, 0 or more, at most four decimals (`"2"`, `"2.5"`, `"2.0000"`).
 *
 * Why: the console sends `percent` as the form's number with four decimals (`"2.0000"`); the range per kind (a discount cannot
 * take more than 100 %) is judged with the rest of the rule, so the message names the field.
 */
export const RulePercent = zDecimal.regex(/^\d{1,5}(\.\d{1,4})?$/, 'Enter a percent such as 2 or 0.5, 0 or more.');
