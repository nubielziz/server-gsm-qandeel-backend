// OrderPlacement: the one shared path that creates an order (portal now, Dhru, REST v1 and the storefront later). It prices the order
// with the catalog's resolver, applies the price-change guard and the duplicate rule, writes the order with its first timeline lines,
// holds the price and writes the dispatch row, all in the caller's transaction (decision 025, user rule 9).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError, type FieldError } from '../../../common/errors';
import { Money } from '../../../common/money';
import { TokenService } from '../../../infra/crypto';
import type { DbExecutor } from '../../../infra/db';
import {
  DEFAULT_PRICE_CHANGE_TOLERANCE_PERCENT,
  InventoryStock,
  ListedPrices,
  MerchantCatalog,
  PRICE_CHANGE_TOLERANCE_BOUNDS,
  PRICE_CHANGE_TOLERANCE_KEY,
  PriceResolver,
  type StockClaim,
  checkPriceChange,
} from '../../catalog';
import { SettingsReader } from '../../platform';
import type { Order, OrderSource } from '../db/schema';
import { mainInputOf } from '../domain/main-input';
import { placementDispatchState } from '../domain/order-machine';
import {
  type TimelineActor,
  type TimelineLine,
  createdLine,
  holdLine,
  manualReviewLine,
} from '../domain/order-timeline';
import {
  type PlacementField,
  inputProblems,
  isValidImei,
  normalizeImei,
  quantityProblem,
  totalOf,
} from '../domain/placement-rules';
import { STOCK_DELIVERY_FROM, stockDeliveryLines } from '../domain/stock-delivery';
import {
  hasActiveSupplierLink,
  merchantFileOf,
  merchantOf,
  serviceAvailabilityOf,
  serviceFieldsOf,
} from '../infra/foreign-reads.repository';
import { findOpenDuplicate, insertEvents, insertOrder, lockFingerprint } from '../infra/order.repository';
import { OrderLedger } from './order-ledger';
import { OrderOutbox } from './order-outbox';

/** One thing to order: an IMEI (type `imei`) and/or the custom field values. */
export interface PlacementItem {
  /** The IMEI as typed (type `imei`). */
  readonly imei?: string | undefined;
  /** Custom field values by field key. */
  readonly inputs: Readonly<Record<string, string>>;
  /** Where the problems of this item are named in the request (`imei`, `imeis.2`): the console maps them onto form fields. */
  readonly imeiField: string;
}

/** What placement needs; one order is created per item. */
export interface PlacementRequest {
  readonly clientId: number;
  readonly source: OrderSource;
  /** The merchant key that placed the order (REST v1, Dhru). */
  readonly apiKeyId?: number | null;
  readonly serviceId: number;
  /** The quantity of each order; the service's minimum when left out. */
  readonly quantity?: number | undefined;
  readonly items: readonly PlacementItem[];
  /** The uploaded input file of a File service. */
  readonly fileId?: number | undefined;
  /** The REST v1 `Idempotency-Key`, kept on the order (a single item only). */
  readonly idempotencyKey?: string | undefined;
  /** Who is recorded as placing it. */
  readonly actor: TimelineActor;
}

const CURRENCY = 'USD';

/** Reads the first field error of a list as the message the problem answers with. */
function detailOf(errors: readonly FieldError[]): string {
  return errors[0]?.message ?? 'Some fields are not valid.';
}

/**
 * Creates orders.
 *
 * Why: scenario manual step 3 and decision 025: "PriceResolver prices this merchant, then in one transaction: the order, its
 * event, the hold and the outbox job". Rules (the brief): the price is the resolver's for this merchant; an order more than the
 * tolerance above the price the merchant last saw is refused (`409 PRICE_CHANGED`, user rule 9), a smaller raise is charged and
 * recorded in `pricing_snapshot`; a second open order for the same service and input is refused under `duplicate_rule =
 * block_open` (`409 DUPLICATE_ORDER`, catalog-2); `orders.imei` holds the main input (orders-suppliers-2); `placed_at` and
 * `created_at` are never set, so both take the transaction time (orders-suppliers-1); the first dispatch state is the placement
 * rule's (manual, or pending with a `order.dispatch_requested` row for the dispatch job of feature 6). An archived, disabled or
 * hidden service is not orderable. All items of a request are placed in the caller's one transaction: the first refusal
 * (`INSUFFICIENT_FUNDS` included) undoes the whole request.
 *
 * Side effects (on the caller's transaction): inserts `orders`, `order_events`, `ledger_transactions` and entries (the hold) and
 * `outbox_events`; takes an advisory lock per duplicate fingerprint.
 *
 * @see docs/decisions/025-order-state-machine.md
 */
@Injectable()
export class OrderPlacement {
  constructor(
    private readonly catalog: MerchantCatalog,
    private readonly resolver: PriceResolver,
    private readonly listedPrices: ListedPrices,
    private readonly settings: SettingsReader,
    private readonly ledger: OrderLedger,
    private readonly outbox: OrderOutbox,
    private readonly tokens: TokenService,
    private readonly stock: InventoryStock,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Places the orders of one request.
   *
   * @param tx the caller's transaction
   * @param request the merchant, the service and the items
   * @returns the stored orders, in the order of the items
   * @throws {AppError} `NOT_FOUND` / `SERVICE_DISABLED` (the service cannot be ordered), `INVALID_IMEI` or `VALIDATION_FAILED`
   *   (422, with the field), `PRICE_CHANGED`, `DUPLICATE_ORDER` (409), `INSUFFICIENT_FUNDS` (402), `UNAUTHORIZED` (the
   *   merchant no longer exists)
   */
  async place(tx: DbExecutor, request: PlacementRequest): Promise<Order[]> {
    const merchant = await merchantOf(tx, request.clientId);
    if (!merchant) throw new AppError('UNAUTHORIZED');
    const entry = await this.catalog.find(tx, { clientId: merchant.id, groupId: merchant.groupId }, request.serviceId);
    if (!entry) throw await this.notOrderable(tx, request.serviceId);
    const { service } = entry;

    const fields = (await serviceFieldsOf(tx, service.id)).map((row): PlacementField => ({
      ...row,
      options: row.options,
    }));
    const quantity = request.quantity ?? service.minQty;
    const file = await this.fileOf(tx, request, service.type);
    const prepared = this.validate(request, service, fields, quantity, file?.filename);

    const resolution = await this.resolver.resolve(tx, {
      serviceId: service.id,
      groupId: merchant.groupId,
      clientId: merchant.id,
    });
    if (!resolution) throw await this.notOrderable(tx, request.serviceId);
    const unit = resolution.price;
    const tolerance = await this.settings.integer(
      PRICE_CHANGE_TOLERANCE_KEY,
      DEFAULT_PRICE_CHANGE_TOLERANCE_PERCENT,
      PRICE_CHANGE_TOLERANCE_BOUNDS,
    );
    const listed = await this.listedPrices.find(tx, merchant.id, service.id);
    const verdict = checkPriceChange(listed?.price ?? null, unit, tolerance, { floorRaised: resolution.clamped });
    if (verdict.outcome === 'refuse') {
      throw new AppError('PRICE_CHANGED', {
        detail: 'The price of this service changed since you last listed it. Refresh the service list and order again.',
        extensions: { listedPrice: verdict.listedPrice.toWire(), currentPrice: verdict.currentPrice.toWire() },
      });
    }
    const snapshot: Record<string, unknown> = {
      source: resolution.source,
      price: unit.toWire(),
      rawPrice: resolution.rawPrice.toWire(),
      floor: resolution.floor.toWire(),
      clamped: resolution.clamped,
      ruleId: resolution.ruleId,
      fx: 1,
      taxRate: 0,
      steps: resolution.steps,
      ...(verdict.outcome === 'raised'
        ? { raised: true, raisedReason: verdict.reason, listedPrice: verdict.listedPrice.toWire() }
        : {}),
    };

    const unitCost = Money.of(service.effectiveCost);
    const hasLink = await hasActiveSupplierLink(tx, service.id);
    const start = placementDispatchState({
      held: false,
      deliveredFromInventory: false,
      manualService: service.fulfillment === 'manual',
      hasActiveSupplierLink: hasLink,
    });
    // An order whose codes come from the stock completes at once (RULES orders 10, orders-suppliers-11).
    const fromStock = placementDispatchState({
      held: false,
      deliveredFromInventory: true,
      manualService: service.fulfillment === 'manual',
      hasActiveSupplierLink: hasLink,
    });
    // One clock time for the whole request. `placed_at` starts the SLA age the pastSla rule reads, and `created_at` is the wire
    // `createdAt` the console's SLA cell reads: both are written from the injected clock, the same instant (decisions 025, 031).
    const now = this.clock.now();

    const placed: Order[] = [];
    for (const item of prepared) {
      const fingerprint =
        item.mainInput === null
          ? null
          : this.tokens.hash(
              `order-duplicate:${merchant.id}:${service.id}:${item.mainInput.replace(/\s+/g, '').toLowerCase()}`,
            );
      if (fingerprint !== null && service.duplicateRule === 'block_open') {
        await lockFingerprint(tx, fingerprint);
        const open = await findOpenDuplicate(tx, fingerprint);
        if (open !== undefined) {
          throw new AppError('DUPLICATE_ORDER', {
            detail: `You already have an open order for this service and input (order ${open}).`,
            extensions: { orderId: open },
          });
        }
      }
      // Codes are claimed per order, after the duplicate check: a short stock sends the order the usual way.
      const claim = await this.stock.claim(tx, service.id, quantity);
      const begin = claim ? fromStock : start;
      const order = await insertOrder(tx, {
        clientId: merchant.id,
        serviceId: service.id,
        type: service.type,
        source: request.source,
        apiKeyId: request.apiKeyId ?? null,
        status: begin.status,
        dispatchState: begin.dispatchState,
        placedAt: now,
        createdAt: now,
        // The delivered codes are the order's result, one per line: the merchant receives them like a supplier's reply.
        ...(claim ? { resultCode: claim.codes.join('\n'), completedAt: now } : {}),
        imei: item.mainInput,
        quantity,
        inputs: item.inputs,
        unitPrice: unit.toWire(),
        totalPrice: totalOf(unit, quantity).toWire(),
        unitCost: unitCost.toWire(),
        totalCost: totalOf(unitCost, quantity).toWire(),
        currency: CURRENCY,
        pricingSnapshot: snapshot,
        fingerprint,
        inputFileId: file?.id ?? null,
        idempotencyKey: prepared.length === 1 ? (request.idempotencyKey ?? null) : null,
      });
      const lines = [
        createdLine(request.source, request.actor),
        holdLine(order.totalPrice, merchant.name),
        ...(begin.dispatchState === 'manual' ? [manualReviewLine()] : []),
      ];
      await insertEvents(tx, eventRows(order.id, lines));
      await this.ledger.hold(tx, order, { type: 'client', id: merchant.id });
      if (claim) await this.deliverFromStock(tx, order, claim);
      if (begin.enqueueDispatch) await this.outbox.dispatchRequested(tx, order.id);
      placed.push(order);
    }
    return placed;
  }

  /**
   * Completes an order whose codes came from the stock: the codes become sold, the hold settles to revenue (no supplier cost,
   * B17), the timeline says so and the merchant's `order.status_changed` event goes out (`pending → completed`).
   */
  private async deliverFromStock(tx: DbExecutor, order: Order, claim: StockClaim): Promise<void> {
    await this.stock.sell(tx, claim, order.id);
    const moved = await this.ledger.move(tx, order, 'complete', {
      actor: { type: 'system', id: null },
      completedBefore: 0,
      costBooked: false,
    });
    await insertEvents(tx, eventRows(order.id, stockDeliveryLines(claim.codes.length, moved)));
    await this.outbox.statusChanged(tx, {
      orderId: order.id,
      clientId: order.clientId,
      fromStatus: STOCK_DELIVERY_FROM,
      toStatus: order.status,
    });
  }

  /** Why a service cannot be ordered: disabled (`SERVICE_DISABLED`) or unknown, archived or hidden from the merchant (`NOT_FOUND`). */
  private async notOrderable(tx: DbExecutor, serviceId: number): Promise<AppError> {
    const availability = await serviceAvailabilityOf(tx, serviceId);
    if (availability && !availability.archived && availability.status === 'disabled') {
      return new AppError('SERVICE_DISABLED', { detail: 'This service is turned off. Choose another service.' });
    }
    return new AppError('NOT_FOUND', { detail: 'No service with this id is available to you.' });
  }

  private async fileOf(tx: DbExecutor, request: PlacementRequest, type: string) {
    if (request.fileId === undefined) return undefined;
    const file = await merchantFileOf(tx, request.clientId, request.fileId);
    if (!file || type !== 'file') {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Choose a file you uploaded for a File service.',
        errors: [{ field: 'fileId', code: 'invalid_file', message: 'Choose a file you uploaded for a File service.' }],
      });
    }
    return file;
  }

  /** Checks every item against the service and returns the main input and the clean inputs of each. */
  private validate(
    request: PlacementRequest,
    service: { type: 'imei' | 'server' | 'remote' | 'file'; minQty: number; maxQty: number; qtyOptions: number[] },
    fields: readonly PlacementField[],
    quantity: number,
    fileName: string | undefined,
  ): Array<{ mainInput: string | null; inputs: Record<string, string> }> {
    const problems: FieldError[] = [];
    const imeiProblems: FieldError[] = [];
    const quantityText = quantityProblem(quantity, service);
    if (quantityText) problems.push({ field: 'quantity', code: 'invalid_quantity', message: quantityText });
    if (service.type === 'file' && request.fileId === undefined && fields.length === 0) {
      problems.push({ field: 'fileId', code: 'required', message: 'Upload the file this service needs.' });
    }
    const prepared = request.items.map((item) => {
      const inputs = Object.fromEntries(Object.entries(item.inputs).map(([key, value]) => [key, value.trim()]));
      let imei: string | undefined;
      if (service.type === 'imei') {
        const typed = item.imei?.trim() ?? '';
        if (typed === '') {
          problems.push({ field: item.imeiField, code: 'required', message: 'Enter the IMEI.' });
        } else {
          imei = normalizeImei(typed);
          if (!isValidImei(imei)) {
            imeiProblems.push({
              field: item.imeiField,
              code: 'invalid_imei',
              message: 'This IMEI is not valid: it must be 15 digits with a correct check digit.',
            });
          }
        }
      } else if (item.imei !== undefined) {
        problems.push({
          field: item.imeiField,
          code: 'not_applicable',
          message: 'This service does not take an IMEI.',
        });
      }
      // A service may define a field keyed `imei` (it carries the pattern the supplier wants): it receives the IMEI itself.
      const fieldInputs =
        imei !== undefined && fields.some((field) => field.key === 'imei') ? { imei, ...inputs } : inputs;
      problems.push(...inputProblems(fields, fieldInputs));
      const stored = { ...inputs };
      return {
        mainInput: mainInputOf({ type: service.type, imei, inputs: fieldInputs, fields, fileName }),
        inputs: stored,
      };
    });
    if (imeiProblems.length > 0) {
      throw new AppError('INVALID_IMEI', { detail: detailOf(imeiProblems), errors: [...imeiProblems, ...problems] });
    }
    if (problems.length > 0) throw new AppError('VALIDATION_FAILED', { detail: detailOf(problems), errors: problems });
    return prepared;
  }
}

/** The `order_events` rows of some timeline lines of one order. */
function eventRows(orderId: number, lines: readonly TimelineLine[]) {
  return lines.map((line) => ({
    orderId,
    type: line.type,
    fromStatus: line.fromStatus,
    toStatus: line.toStatus,
    actorType: line.actor.type,
    actorId: line.actor.id,
    data: line.data,
  }));
}
