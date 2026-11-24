// Route contract of the Dhru action `accountinfo` (map domain E, stage 7, decision 026): the wallet figure a Dhru client shows.
import { z } from 'zod';
import { zSignedMoney } from '../../../common/contract';
import { defineDhruAction } from '../../../common/dhru';

/** The Dhru action `accountinfo`: `{ message, AccoutInfo: { credit, mail, currency } }` (the spelling of the standard). */
export const dhruAccountInfo = defineDhruAction({
  key: 'DHRU accountinfo',
  summary: 'Account info',
  description:
    "The merchant's available balance (`credit`: the wallet balance plus the credit limit), email and currency. The key `AccoutInfo` is " +
    'spelled as in the Dhru Fusion standard.',
  success: z.object({
    message: z.literal('Your Accout Info'),
    AccoutInfo: z.object({
      credit: zSignedMoney.describe('What the merchant may spend now: balance plus credit limit.'),
      mail: z.string(),
      currency: z.string(),
    }),
  }),
  errors: ['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'ACCOUNT_PENDING_APPROVAL', 'IP_NOT_ALLOWED', 'RATE_LIMITED'],
  examples: {
    response: {
      message: 'Your Accout Info',
      AccoutInfo: { credit: '3209.7500', mail: 'ops@zainmobilehub.example', currency: 'USD' },
    },
  },
});
