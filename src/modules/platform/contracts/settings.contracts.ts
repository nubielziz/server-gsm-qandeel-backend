// Route contracts of the system settings (map domain G, routes /admin/settings, stage 2): read the flat settings object and
// change the keys the allow-list permits. Shapes match the console's Settings (docs/contract/endpoints/platform.md).
import { z } from 'zod';
import { type JsonValue, defineRoute, zJsonObject } from '../../../common/contract';

/** Any JSON value, as the console's `JsonValue` (the alias lets the contract tests recognise it). */
const AnyJson = z
  .custom<JsonValue>((value) => z.json().safeParse(value).success, 'Must be a JSON value.')
  .meta({ 'x-gsm-alias': 'JsonValue', description: 'Any JSON value.' });

/** What one setting holds: a scalar, a list, a JSON object, or `null`; the console types it the same way. */
const SettingValue = z.union([z.string(), z.number(), z.boolean(), z.array(AnyJson), zJsonObject]).nullable();

/**
 * The flat settings object: every non-secret key with its JSON value.
 *
 * Why: the console reads one typed key and shows every other key read-only as JSON (MISMATCHES B66); a key that was never
 * set is absent.
 */
const Settings = z
  .object({
    adminAllowlistOnly: z.boolean().optional(),
  })
  .catchall(SettingValue);

/** `GET /admin/settings`: the settings. */
export const getSettings = defineRoute({
  key: 'GET /admin/settings',
  summary: 'Read the system settings',
  description:
    'One flat object `{key: value}` of every settings row. Values keep their JSON type. Keys whose names mark a secret ' +
    '(token, password, key, hash) are never sent.',
  tags: ['settings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'settings:read',
  success: { status: 200, schema: Settings },
  errors: ['UNAUTHORIZED', 'FORBIDDEN'],
  examples: { response: { adminAllowlistOnly: true, 'pricing.price_change_tolerance_percent': 10 } },
});

/** `PATCH /admin/settings`: change allow-listed settings. */
export const updateSettings = defineRoute({
  key: 'PATCH /admin/settings',
  summary: 'Change system settings',
  description:
    'Only keys of the settings registry (`settings/settings-registry.ts`) are accepted, each with its validator (for example ' +
    '`pricing.price_change_tolerance_percent`, a whole number of percent from 0 to 100, default 10; ' +
    '`fx.max_refresh_move_percent`, a whole number of percent from 1 to 100, default 20, and ' +
    '`fx.max_rate_age_hours`, a whole number of hours from 1 to 720, default 48, and `wallet.receipt_approval_limit`, a whole number ' +
    'of dollars, default 10000, decision 049). Any other ' +
    'key, including the keys that have their own guarded routes (`adminAllowlistOnly`, `maintenance`, the risk rules, the ' +
    'storefront policies), is `422` with `errors[].field` set to the key. Answers the whole settings object after the change. ' +
    'A key reserved to Owners (`suppliers.allowPlainHttp`, decision 051; `fx.max_refresh_move_percent`, `fx.max_rate_age_hours`, ' +
    '`wallet.customer.adjust_approval_limit` and `wallet.receipt_approval_limit`, decision 049) is `403 FORBIDDEN` for any other caller, ' +
    'and nothing in the patch is stored; ' +
    'the route itself keeps `settings:update`.',
  tags: ['settings'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'settings:update',
  body: Settings,
  success: { status: 200, schema: Settings },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'VALIDATION_FAILED'],
  examples: {
    request: { 'pricing.price_change_tolerance_percent': 5 },
    response: { adminAllowlistOnly: true, 'pricing.price_change_tolerance_percent': 5 },
  },
});
