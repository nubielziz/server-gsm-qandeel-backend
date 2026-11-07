// ApiOrdersService: the use cases of the REST v1 order routes (map domain D, stage 7): place (with the `Idempotency-Key`), place in bulk,
// list, show, cancel and verify. Placement is feature 5's one path (`OrderPlacement.place`); this adds the key's replay, the per-item
// answers of a bulk and the cursor reads. Every call acts for the merchant behind the API key only.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { type JsonObject, cutPage, decodeCursor } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService, type Transaction } from '../../../infra/db';
import type { OrderSource } from '../db/schema';
import { type ApiOrderFilter, findOrderRow, pageMerchantOrderRows } from '../infra/order-read.repository';
import { ClientOrdersService } from './client-orders.service';
import { IdempotencyStore } from './idempotency-store';
import { OrderPlacement } from './order-placement';
import { type MerchantOrderView, toMerchantOrder } from './order-views';

/** Who calls: the merchant behind the API key and the key itself. */
export interface ApiCaller {
  readonly clientId: number;
  readonly keyId: number;
}

/** One order to place, as REST v1 sends it. */
export interface ApiPlaceItem {
  readonly serviceId: number;
  readonly imei?: string | undefined;
  readonly quantity?: number | undefined;
  readonly inputs?: Readonly<Record<string, string>> | undefined;
  readonly fileId?: number | undefined;
}

/** The refusal of one bulk item, in the shape of the problem it would have been alone. */
export interface ApiItemError {
  readonly code: string;
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly errors?: ReadonlyArray<{ field: string; code: string; message: string }>;
  readonly listedPrice?: string;
  readonly currentPrice?: string;
  readonly orderId?: number;
}

/** The result of one item of a bulk placement. */
export type ApiBulkResult =
  | { readonly index: number; readonly ok: true; readonly order: MerchantOrderView }
  | { readonly index: number; readonly ok: false; readonly error: ApiItemError };

/** What a REST v1 list asks for. */
export interface ApiOrderListQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly status?: ApiOrderFilter['statuses'];
  readonly ids?: ApiOrderFilter['ids'];
  readonly imei?: string | undefined;
  readonly updatedSince?: Date | undefined;
}

/** The answer of a placement route: the status and body to send, and whether a stored answer was replayed. */
export interface ApiPlaced {
  readonly status: number;
  readonly body: JsonObject;
  readonly replayed: boolean;
}

/** The main input without whitespace, as `orders.imei` is compared (the bulk reply uses the same rule). */
const squash = (text: string): string => text.replace(/\s+/g, '');

/** Reads the problem an error would have answered with, for a bulk item. */
function itemErrorOf(error: AppError): ApiItemError {
  const extensions = error.extensions;
  const text = (key: string): string | undefined => {
    const value = extensions[key];
    return typeof value === 'string' ? value : undefined;
  };
  const orderId = extensions['orderId'];
  return {
    code: error.code,
    status: error.status,
    title: error.title,
    detail: error.detail ?? error.title,
    ...(error.errors.length > 0
      ? { errors: error.errors.map((e) => ({ field: e.field, code: e.code, message: e.message })) }
      : {}),
    ...(text('listedPrice') === undefined ? {} : { listedPrice: text('listedPrice')! }),
    ...(text('currentPrice') === undefined ? {} : { currentPrice: text('currentPrice')! }),
    ...(typeof orderId === 'number' ? { orderId } : {}),
  };
}

/**
 * Runs the order use cases of REST v1.
 *
 * Why: the map's `/v1/orders` rows: an integration places, follows, cancels and verifies orders with its API key. There is one placement
 * path: price from the resolver, the price guard of user rule 9, the duplicate rule, the hold and the dispatch row are
 * `OrderPlacement.place`, called on this service's transaction, so a REST v1 order is exactly a portal or Dhru order with source `v1`
 * and the key's id. Under an `Idempotency-Key` the transaction checks and locks the key first and stores the answer before it commits
 * ({@link IdempotencyStore}). A bulk places every item inside a savepoint of that one transaction: an item that is refused undoes only
 * itself and is answered in its place, the others stand, and the stored answer is all of them. Cancel and verify are the portal's
 * (feature 5's transitions with the service's flags and window). A merchant sees its own orders only: another merchant's id is `404`.
 *
 * Side effects: per placement the writes of `OrderPlacement.place` (orders, events, the hold, outbox) and, under a key, one
 * `idempotency_keys` row; reads write nothing. No audit row: machine calls of a merchant write none (B121); the order's timeline names the
 * merchant as the actor.
 *
 * @see docs/contract/ALIGNMENT.md (§ 7)
 */
@Injectable()
export class ApiOrdersService {
  constructor(
    private readonly db: DbService,
    private readonly placement: OrderPlacement,
    private readonly clientOrders: ClientOrdersService,
    private readonly idempotency: IdempotencyStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Places one order.
   *
   * @param caller the merchant and the key
   * @param item the order
   * @param key the `Idempotency-Key`, when the caller sent one
   * @returns `201` and the order as the merchant reads it (or the stored answer of an earlier request with the key)
   * @throws {AppError} see {@link OrderPlacement.place}; `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`
   */
  async place(caller: ApiCaller, item: ApiPlaceItem, key: string | undefined): Promise<ApiPlaced> {
    return this.db.runInTransaction(async ({ tx }) => {
      const work = async () => ({ status: 201, body: await this.placeOne(tx, caller, item, key) });
      if (key === undefined) return { ...(await work()), replayed: false };
      return this.idempotency.run(
        tx,
        { clientId: caller.clientId, key, scope: 'order', requestHash: this.idempotency.hashOf('order', item) },
        work,
      );
    });
  }

  /**
   * Places up to 100 orders, each answered on its own.
   *
   * @param caller the merchant and the key
   * @param items the orders, in the order they are placed
   * @param key the `Idempotency-Key`, when the caller sent one
   * @returns `200` and one result per item (or the stored answer of an earlier request with the key)
   * @throws {AppError} `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`; a failure that is not a refusal undoes everything
   */
  async placeBulk(caller: ApiCaller, items: readonly ApiPlaceItem[], key: string | undefined): Promise<ApiPlaced> {
    return this.db.runInTransaction(async ({ tx }) => {
      const work = async () => {
        const results: ApiBulkResult[] = [];
        for (const [index, item] of items.entries()) {
          try {
            // A savepoint: a refusal undoes this item's writes (its hold, its order) and nothing else.
            const order = await tx.transaction((savepoint) => this.placeOne(savepoint, caller, item, undefined));
            results.push({ index, ok: true, order: order as unknown as MerchantOrderView });
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            results.push({ index, ok: false, error: itemErrorOf(error) });
          }
        }
        return { status: 200, body: { results } as unknown as JsonObject };
      };
      if (key === undefined) return { ...(await work()), replayed: false };
      return this.idempotency.run(
        tx,
        {
          clientId: caller.clientId,
          key,
          scope: 'bulk',
          requestHash: this.idempotency.hashOf('bulk', { orders: items }),
        },
        work,
      );
    });
  }

  /**
   * Reads a page of the merchant's orders, newest first.
   *
   * @param clientId the merchant
   * @param query the page size, the cursor and the filters
   * @returns the orders and the cursor of the next page (`null` on the last)
   * @throws {AppError} `VALIDATION_FAILED` on `cursor`
   */
  async list(
    clientId: number,
    query: ApiOrderListQuery,
  ): Promise<{ data: MerchantOrderView[]; nextCursor: string | null }> {
    const beforeId = query.cursor === undefined ? undefined : decodeCursor(query.cursor, ['number'] as const)[0];
    const rows = await pageMerchantOrderRows(
      this.db.db,
      clientId,
      {
        statuses: query.status,
        ids: query.ids,
        input: query.imei === undefined ? undefined : squash(query.imei),
        updatedSince: query.updatedSince,
      },
      { limit: query.limit + 1, beforeId },
    );
    const page = cutPage(rows, query.limit, (row) => [row.order.id]);
    const now = this.clock.now();
    return { data: page.data.map((row) => toMerchantOrder(row, now)), nextCursor: page.nextCursor };
  }

  /**
   * Shows one of the merchant's orders.
   *
   * @param clientId the merchant
   * @param orderId the order id
   * @returns the order as the merchant reads it
   * @throws {AppError} `NOT_FOUND` for an unknown id or another merchant's order
   */
  async show(clientId: number, orderId: number): Promise<MerchantOrderView> {
    const row = await findOrderRow(this.db.db, { kind: 'merchant', clientId }, orderId);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No order with this id.' });
    return toMerchantOrder(row, this.clock.now());
  }

  /**
   * Cancels an order that was never sent, when its service allows it.
   *
   * @param clientId the merchant
   * @param orderId the order id
   * @returns the order after the cancellation
   * @throws {AppError} see {@link ClientOrdersService.cancel}
   */
  async cancel(clientId: number, orderId: number): Promise<MerchantOrderView> {
    await this.clientOrders.cancel(clientId, orderId);
    return this.show(clientId, orderId);
  }

  /**
   * Asks for the verification of a completed order.
   *
   * @param clientId the merchant
   * @param orderId the order id
   * @returns the order after the request
   * @throws {AppError} see {@link ClientOrdersService.verify}
   */
  async verify(clientId: number, orderId: number): Promise<MerchantOrderView> {
    await this.clientOrders.verify(clientId, orderId);
    return this.show(clientId, orderId);
  }

  /**
   * Places one order on a transaction and reads it back as the merchant sees it.
   *
   * @returns the order view, as plain JSON (it is stored with the key and replayed)
   */
  private async placeOne(
    tx: Transaction,
    caller: ApiCaller,
    item: ApiPlaceItem,
    key: string | undefined,
  ): Promise<JsonObject> {
    const [order] = await this.placement.place(tx, {
      clientId: caller.clientId,
      source: 'v1' satisfies OrderSource,
      apiKeyId: caller.keyId,
      serviceId: item.serviceId,
      quantity: item.quantity,
      items: [{ imei: item.imei, inputs: item.inputs ?? {}, imeiField: 'imei' }],
      fileId: item.fileId,
      // The key is kept on the order of a single placement (the unique index of `orders.idempotency_key` backs the store).
      idempotencyKey: key,
      actor: { type: 'client', id: caller.clientId },
    });
    const row = await findOrderRow(tx, { kind: 'merchant', clientId: caller.clientId }, order!.id);
    return toMerchantOrder(row!, this.clock.now()) as unknown as JsonObject;
  }
}
