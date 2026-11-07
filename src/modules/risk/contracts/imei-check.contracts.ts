// Route contract of the storefront IMEI check (map domain K, stage 14): POST /store/v1/imei/check. The console has no screen for it
// (the storefront is another frontend): the shape follows ALIGNMENT § 7 and is written up in the module README.
import { z } from 'zod';
import { defineRoute, zId, zIsoDateTime } from '../../../common/contract';
import { IMEI_CHECK_STATUSES } from '../db/schema';

const CheckBody = z.object({
  imei: z
    .string()
    .trim()
    .min(1, 'Enter the IMEI.')
    .max(64, 'Too long.')
    .describe('15 digits; spaces and dashes are ignored.'),
  serviceId: zId
    .optional()
    .describe(
      'The service the buyer is about to order: a check before an order (`pre_order`). Without it the check is the free tool.',
    ),
});

/** `POST /store/v1/imei/check`. */
export const checkStoreImei = defineRoute({
  key: 'POST /store/v1/imei/check',
  summary: 'Check an IMEI',
  description:
    'Reads an IMEI before payment: 15 digits with a valid Luhn check digit (else `422 INVALID_IMEI`), then the device the first 8 ' +
    'digits (the TAC) name in the catalogue. Blacklist and lock status come with a later stage, so `status` is `unknown` for now. ' +
    'The IMEI is stored encrypted with a keyed hash for lookups, never logged; every check writes its own record and is never ' +
    "answered from another visitor's check (`cached` stays false here). With `serviceId` the check counts as `pre_order` for that " +
    'service, without it as the ' +
    'free tool (`storefront_free`). Needs the anti-bot token (`X-Turnstile-Token`).',
  tags: ['storefront'],
  surface: 'store',
  access: 'public',
  turnstile: true,
  body: CheckBody,
  success: {
    status: 200,
    schema: z.object({
      imei: z.string().describe('The 15 digits, as read.'),
      status: z.enum(IMEI_CHECK_STATUSES).describe('`unknown` until the blacklist and lock lookup exists.'),
      checks: z.object({
        checksum: z.literal('valid'),
        tac: z.enum(['known', 'unknown']).describe('Whether the catalogue knows the first 8 digits.'),
      }),
      device: z
        .object({
          tac: z.string(),
          brand: z.string(),
          model: z.string(),
          marketingName: z.string(),
          releaseYear: z.number().int().nullable(),
        })
        .nullable()
        .describe('Null when the TAC is not in the catalogue.'),
      cached: z
        .boolean()
        .describe(
          'True when a stored result was reused. Always false for this check: only the paid supplier check reuses results.',
        ),
      checkedAt: zIsoDateTime.describe('When the result was produced.'),
    }),
  },
  errors: ['INVALID_IMEI', 'VALIDATION_FAILED'],
  examples: {
    request: { imei: '353890110000004', serviceId: 1 },
    response: {
      imei: '353890110000004',
      status: 'unknown',
      checks: { checksum: 'valid', tac: 'known' },
      device: { tac: '35389011', brand: 'Apple', model: 'iPhone 13', marketingName: 'iPhone 13', releaseYear: 2021 },
      cached: false,
      checkedAt: '2026-11-07T12:00:00.000Z',
    },
  },
});
