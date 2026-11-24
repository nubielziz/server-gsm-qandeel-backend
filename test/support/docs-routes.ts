// Fixture contracts for the documentation tests: one route per surface the public/internal filter has to tell apart
// (merchant portal, admin) plus a tag that two surfaces share. Together with the Dhru-like and staff routes of
// routes.ts they make a small API. Keys live under /t/ so they never clash with real routes.
import { Controller } from '@nestjs/common';
import { z } from 'zod';
import { type ResultOf, Route, defineRoute, zId, zIsoDateTime, zMoney } from '@src/common/contract';

const OrderRow = z.object({ id: zId, total: zMoney, createdAt: zIsoDateTime });
const order = { id: 1, total: '12.4900', createdAt: '2026-03-01T09:30:00.000Z' };

export const clientPlaceOrder = defineRoute({
  key: 'POST /client/t/orders',
  summary: 'Place an order (merchant portal fixture)',
  tags: ['orders'],
  surface: 'client',
  access: 'merchant-session',
  body: z.object({ serviceId: zId }),
  success: { status: 201, schema: OrderRow },
  errors: ['UNAUTHORIZED', 'VALIDATION_FAILED'],
  examples: { request: { serviceId: 3 }, response: order },
});

export const adminListOrders = defineRoute({
  key: 'GET /admin/t/orders',
  summary: 'List orders (admin fixture)',
  tags: ['orders'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'orders:read',
  success: { status: 200, schema: z.object({ data: z.array(OrderRow) }) },
  errors: ['UNAUTHORIZED', 'FORBIDDEN'],
});

export const clientWallet = defineRoute({
  key: 'GET /client/t/wallet',
  summary: 'Show the wallet (merchant portal fixture)',
  tags: ['wallet'],
  surface: 'client',
  access: 'merchant-session',
  success: { status: 200, schema: z.object({ balance: zMoney }) },
  errors: ['UNAUTHORIZED'],
});

/** Handlers for the fixture contracts; none of them is ever called by the documentation tests. */
@Controller()
export class DocsFixtureController {
  @Route(clientPlaceOrder)
  clientPlace(): ResultOf<typeof clientPlaceOrder> {
    return order;
  }

  @Route(adminListOrders)
  adminList(): ResultOf<typeof adminListOrders> {
    return { data: [order] };
  }

  @Route(clientWallet)
  wallet(): ResultOf<typeof clientWallet> {
    return { balance: '5.0000' };
  }
}
