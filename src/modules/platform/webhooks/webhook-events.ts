// The four events merchants receive (ALIGNMENT § 7, decision 017): one defineEvent per event, so the public OpenAPI document lists
// them under `webhooks` with the envelope, the signature header and the retry rule. `service.price_changed` is a backend
// addition to the map's three events (user rule 9, MISMATCHES B117: route parity allows it under that entry).
import { z } from 'zod';
import { defineEvent, zId, zIsoDateTime, zMoney } from '../../../common/contract';

/** The order statuses a merchant sees (decision 025: the internal dispatch state is never sent). */
const OrderStatus = z.enum(['pending', 'processing', 'completed', 'rejected']);

const ORDER_EXAMPLE = {
  orderId: 48102,
  serviceId: 12,
  serviceName: 'iPhone iCloud Clean',
  status: 'completed',
  previousStatus: 'processing',
  imei: '356938035643809',
  quantity: 1,
  unitPrice: '4.5000',
  totalPrice: '4.5000',
  currency: 'USD',
  resultCode: 'CLEAN',
  resultComment: 'Device is clean',
  placedAt: '2026-11-01T09:30:00.000Z',
  completedAt: '2026-11-01T09:42:10.000Z',
} as const;

/** `order.status_changed`: an order of the merchant changed status. */
export const orderStatusChanged = defineEvent({
  key: 'EVENT order.status_changed',
  summary: 'An order changed status',
  description:
    'Sent once for every status change of an order the merchant placed (through Dhru, REST v1 or the portal). `status` is the ' +
    'new status and `previousStatus` the one before; `completedAt` is set when the order is completed. `imei` is the main ' +
    'input of the order. Costs, suppliers and internal notes are never part of the event.',
  payload: z.object({
    orderId: zId,
    serviceId: zId,
    serviceName: z.string(),
    status: OrderStatus,
    previousStatus: OrderStatus,
    imei: z.string().nullable(),
    quantity: z.number().int(),
    unitPrice: zMoney,
    totalPrice: zMoney,
    currency: z.string(),
    resultCode: z.string().nullable(),
    resultComment: z.string().nullable(),
    placedAt: zIsoDateTime,
    completedAt: zIsoDateTime.nullable(),
  }),
  example: ORDER_EXAMPLE,
});

/** `wallet.low_balance`: the available balance fell below the merchant's alert threshold. */
export const walletLowBalance = defineEvent({
  key: 'EVENT wallet.low_balance',
  summary: 'The available balance is low',
  description:
    'Sent once each time a posting takes the available balance (balance plus credit limit) from the alert threshold or above ' +
    'to below it. It is not sent again until the balance has been at or above the threshold and fallen under it once more.',
  payload: z.object({ currency: z.string(), available: zMoney, threshold: zMoney }),
  example: { currency: 'USD', available: '42.5000', threshold: '50.0000' },
});

/** `invoice.paid`: a manual invoice was paid and the wallet was credited. */
export const invoicePaid = defineEvent({
  key: 'EVENT invoice.paid',
  summary: 'An invoice was paid',
  description: 'Sent when an invoice of the merchant is paid and its amount is credited to the wallet.',
  payload: z.object({
    invoiceId: zId,
    number: z.string(),
    amount: zMoney,
    currency: z.string(),
    paidAt: zIsoDateTime,
  }),
  example: {
    invoiceId: 311,
    number: 'INV-2026-0311',
    amount: '250.0000',
    currency: 'USD',
    paidAt: '2026-11-01T11:05:00.000Z',
  },
});

/** `service.price_changed`: the price of a service changed for a merchant who ordered it in the last 30 days. */
export const servicePriceChanged = defineEvent({
  key: 'EVENT service.price_changed',
  summary: 'A service price changed',
  description:
    'Sent to a merchant who ordered the service in the last 30 days when the price it would pay now differs from the price of ' +
    'its last order. `previousPrice` is the price of that last order and `price` the price a new order is charged now. Refresh ' +
    'the price list before ordering: an order priced far above the price last listed is refused with `PRICE_CHANGED`.',
  payload: z.object({
    serviceId: zId,
    serviceName: z.string(),
    previousPrice: zMoney.nullable(),
    price: zMoney,
    currency: z.string(),
  }),
  example: {
    serviceId: 12,
    serviceName: 'iPhone iCloud Clean',
    previousPrice: '4.5000',
    price: '4.8000',
    currency: 'USD',
  },
});
