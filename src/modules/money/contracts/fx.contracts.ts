// Route contract of the exchange-rate refresh (map domain E, stage 14, route POST /admin/currencies/refresh-fx): the answer
// matches the console's `RefreshFxResult` (src/features/settings/types/currencies.ts).
import { z } from 'zod';
import { defineRoute, zDecimal, zIsoDateTime } from '../../../common/contract';

/** What a refresh did. */
export const RefreshFxSchema = z.object({
  refreshed: z.array(z.object({ code: z.string(), rateToBase: zDecimal, rateUpdatedAt: zIsoDateTime })),
  failed: z.array(z.object({ code: z.string(), message: z.string() })),
  source: z.string().describe('The name of the driver the rates came from.'),
});

/** `POST /admin/currencies/refresh-fx`. */
export const refreshFx = defineRoute({
  key: 'POST /admin/currencies/refresh-fx',
  summary: 'Refresh the exchange rates',
  description:
    'Fetches the latest rates for every active non-base currency from the configured provider (decision 029) and stores them; ' +
    '`rateUpdatedAt` is now and the currencies stop being stale. A currency the provider does not offer is in `failed` with ' +
    '"Not offered by the provider" and the answer is still `200`. `502 FX_PROVIDER_DOWN` when no rate could be fetched at all ' +
    'or no provider is configured ("No exchange-rate provider is configured."); the old rates stay. Audited. A rate that moved more ' +
    "than `fx.max_refresh_move_percent` (default 20) from the stored one is not stored: it is in `failed` with a message that names the provider's rate, " +
    'the stored rate, the move judged (the larger rate over the smaller one, one decimal) and the bound; the currency is stale and the shop does not offer it until staff confirm a rate; a refresh that held a rate is never `502` ' +
    '(decision 049).',
  tags: ['clients'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'currencies:update',
  success: { status: 200, schema: RefreshFxSchema },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'FX_PROVIDER_DOWN'],
  examples: {
    response: {
      refreshed: [{ code: 'GBP', rateToBase: '0.7912', rateUpdatedAt: '2026-11-07T10:00:00.000Z' }],
      failed: [{ code: 'XYZ', message: 'Not offered by the provider' }],
      source: 'openexchangerates',
    },
  },
});
