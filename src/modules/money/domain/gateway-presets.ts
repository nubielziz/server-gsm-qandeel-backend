// The catalog of ready-made payment methods (feature 32, decision 041, spec B232) and the rules for adding a method from it. Pure: the gateway
// service reads the request and applies these; nothing here touches the database.
import type { FieldError } from '../../../common/errors';
import { GATEWAY_PRESET_KEYS, type GatewayPresetKey, type TopupMethod } from '../db/schema';

/** A ready-made payment method of the catalog. */
export interface GatewayPreset {
  /** The stable key a method remembers (`payment_gateways.preset`) and a frontend names its bundled logo by. */
  readonly key: GatewayPresetKey;
  readonly name: string;
  /** `manual`: staff review a receipt; `automatic`: a gateway confirms (it needs a driver). */
  readonly kind: 'manual' | 'automatic';
  /** Whether a method can be added from it yet (an automatic one waits for its driver). */
  readonly available: boolean;
  /** The driver name the new method gets; no code stands behind a manual one. */
  readonly driver: string;
  /** The top-up method the payments of a method made from it carry. */
  readonly methodType: TopupMethod;
  /** The transfer details with blanks (`________`) for staff to fill in; empty for an automatic preset. */
  readonly instructions: string;
}

/**
 * The ready-made payment methods, in the order the console shows them.
 *
 * Why: the owner asked on 2026-11-17 for these methods to be ready to switch on, each with its logo (B232, decision 041). The six manual
 * transfers can be added now; NOWPayments and Binance Pay through its merchant API are listed as not available (coming soon) until a
 * driver exists. Nothing is inserted into a database by this list, so every environment starts with no method and the same catalog.
 */
export const GATEWAY_PRESETS: readonly GatewayPreset[] = [
  {
    key: 'bank_transfer',
    name: 'Bank transfer',
    kind: 'manual',
    available: true,
    driver: 'bank_transfer',
    methodType: 'bank',
    instructions:
      'Bank: ________, account name: ________, IBAN: ________. Write your top-up number as the reference and upload the receipt.',
  },
  {
    key: 'crypto_transfer',
    name: 'Crypto transfer',
    kind: 'manual',
    available: true,
    driver: 'crypto_transfer',
    methodType: 'usdt',
    instructions:
      'Send USDT on the ________ network to the address ________ and upload a screenshot with the transaction hash.',
  },
  {
    key: 'vodafone_cash',
    name: 'Vodafone Cash',
    kind: 'manual',
    available: true,
    driver: 'vodafone_cash',
    methodType: 'bank',
    instructions:
      'Send the amount to the Vodafone Cash number ________ and upload a screenshot of the transfer. Write your top-up number in the note.',
  },
  {
    key: 'fawry_transfer',
    name: 'Fawry',
    kind: 'manual',
    available: true,
    driver: 'fawry_transfer',
    methodType: 'bank',
    instructions:
      'Pay the amount through Fawry to the account ________ and upload a photo or screenshot of the receipt. Write your top-up number in the note.',
  },
  {
    key: 'instapay',
    name: 'InstaPay',
    kind: 'manual',
    available: true,
    driver: 'instapay',
    methodType: 'bank',
    instructions:
      'Send the amount by InstaPay to the address ________ and upload a screenshot of the transfer. Write your top-up number in the note.',
  },
  {
    key: 'binance_pay',
    name: 'Binance Pay',
    kind: 'manual',
    available: true,
    driver: 'binance_pay',
    methodType: 'usdt',
    instructions:
      'Send the amount by Binance Pay to the Pay ID ________ and upload a screenshot of the transfer. Write your top-up number in the note.',
  },
  {
    key: 'nowpayments',
    name: 'NOWPayments',
    kind: 'automatic',
    available: false,
    driver: 'nowpayments',
    methodType: 'usdt',
    instructions: '',
  },
  {
    key: 'binance_pay_auto',
    name: 'Binance Pay (automatic)',
    kind: 'automatic',
    available: false,
    driver: 'binance_pay_auto',
    methodType: 'usdt',
    instructions: '',
  },
];

/**
 * Finds a catalog entry.
 *
 * @param key the preset key a request or a row carries
 * @returns the entry, or `undefined` when the key is not in the catalog
 */
export function presetOf(key: string | null | undefined): GatewayPreset | undefined {
  if (key === null || key === undefined) return undefined;
  return GATEWAY_PRESETS.find((preset) => preset.key === key);
}

/** The fields of a create request that a preset constrains. */
export interface PresetInput {
  /** The `preset` the request names; `undefined` or `null` is a custom method (nothing to check). */
  readonly preset?: string | null | undefined;
  readonly isManual: boolean;
  readonly driver: string;
}

/**
 * Checks a create request that names a preset.
 *
 * Why: a method made from the catalog must be what the catalog says: a known, available key, the kind (manual or automatic) and the driver
 * name of the entry. Otherwise a manual method could carry the key of an automatic one (and its logo) or a driver that does not match its
 * top-up method. A request without a preset is a custom method and is never checked here.
 *
 * @param input the preset key, the request's `isManual` and `driver`
 * @returns every problem found as a field error: `preset` `unknown` (the only one reported for an unknown key) or `unavailable`,
 *   `isManual` `preset_kind`, `driver` `preset_driver`; empty for a custom method or a request that matches its preset
 */
export function presetProblems(input: PresetInput): FieldError[] {
  if (input.preset === null || input.preset === undefined) return [];
  const preset = presetOf(input.preset);
  if (preset === undefined) {
    return [
      {
        field: 'preset',
        code: 'unknown',
        message: `The ready-made method "${input.preset}" does not exist. Choose one of: ${GATEWAY_PRESET_KEYS.join(', ')}.`,
      },
    ];
  }
  const problems: FieldError[] = [];
  if (!preset.available) {
    problems.push({
      field: 'preset',
      code: 'unavailable',
      message: `${preset.name} cannot be added yet: its connection is not built.`,
    });
  }
  problems.push(...kindAndDriverProblems(preset, input));
  return problems;
}

/** The refusals on `isManual` (`preset_kind`) and `driver` (`preset_driver`) of a method that must stay what its preset says. */
function kindAndDriverProblems(preset: GatewayPreset, merged: Pick<PresetInput, 'isManual' | 'driver'>): FieldError[] {
  const problems: FieldError[] = [];
  if (merged.isManual !== (preset.kind === 'manual')) {
    problems.push({
      field: 'isManual',
      code: 'preset_kind',
      message: `${preset.name} is ${preset.kind === 'manual' ? 'a manual' : 'an automatic'} method.`,
    });
  }
  if (merged.driver !== preset.driver) {
    problems.push({
      field: 'driver',
      code: 'preset_driver',
      message: `The driver of ${preset.name} is "${preset.driver}".`,
    });
  }
  return problems;
}

/**
 * Checks that a stored method made from a preset still has what the preset promises after a change.
 *
 * Why: the preset names the logo a shop or a console shows and the top-up method of its payments (feature 32, B232). A row that says
 * `vodafone_cash` but is patched into an automatic `card` gateway would show the Vodafone Cash logo on a card payment, so a change may not
 * move a preset-made method away from the kind and the driver of its entry. Only these two are pinned: the `unknown` and `unavailable`
 * checks belong to a create, and an existing row stays editable (its name, fees, limits, instructions, groups and switch are free).
 *
 * @param presetKey the `preset` stored on the row (`null` for a custom method, which is never pinned)
 * @param merged the row's `isManual` and `driver` after the change (the stored values for a field the request did not send)
 * @returns `isManual` `preset_kind` and/or `driver` `preset_driver`; empty for a custom method, or when the merged row still matches its
 *   preset, or when the stored key is not in the catalog (a key a later release dropped)
 */
export function presetPinProblems(
  presetKey: string | null | undefined,
  merged: Pick<PresetInput, 'isManual' | 'driver'>,
): FieldError[] {
  const preset = presetOf(presetKey);
  return preset === undefined ? [] : kindAndDriverProblems(preset, merged);
}
