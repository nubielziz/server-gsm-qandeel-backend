// OrderPlacement: the one shared path that creates an order (portal now, Dhru and the storefront later). It prices the order
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
import { AccountDirectory, canAct } from '../../identity';
import { AccountWallets } from '../../money';
import { SettingsReader } from '../../platform';
import type { Order } from '../db/schema';
import { PLACEMENT_REFUSAL_DETAILS, placementRefusal } from '../domain/buyer-rules';
import { inputsByFieldName } from '../domain/field-inputs';
import { bridgedImeiOf, mainInputOf } from '../domain/main-input';
import { placementDispatchState } from '../domain/order-machine';
import {
  type TimelineActor,
  type TimelineLine,
  createdLine,
  holdLine,
  manualReviewLine,
} from '../domain/order-timeline';
import {
  type PlacedOrderSource,
  type PlacementField,
  inputProblems,
  normalizedInputs,
  quantityProblem,
  totalOf,
} from '../domain/placement-rules';
import { STOCK_DELIVERY_FROM, stockDeliveryLines } from '../domain/stock-delivery';
import {
  hasActiveSupplierLink,
  merchantFileOf,
  serviceAvailabilityOf,
  serviceFieldsOf,
} from '../infra/foreign-reads.repository';
import { asTransaction } from '../infra/buyer.repository';
import { findOpenDuplicate, insertEvents, insertOrder, lockFingerprint } from '../infra/order.repository';
import { OrderLedger } from './order-ledger';
import { OrderOutbox } from './order-outbox';

/** One thing to order: the custom field values and, from older callers of an IMEI service, the main input sent as `imei`. */
export interface PlacementItem {
  /** The main input sent as `imei` (type `imei`: the value of the main-input field, decision 073). */
  readonly imei?: string | undefined;
  /** Custom field values by field key (by field Name, or key, for a Dhru order: decision 065). */
  readonly inputs: Readonly<Record<string, string>>;
  /**
   * Where the problems of this item's `imei` are named in the request (`imei`, `imeis.2`, Dhru's `IMEI`): the forms map them onto their
   * fields. A value typed into the main-input field is reported on `inputs.<key>` instead (decision 070).
   */
  readonly imeiField: string;
}

/** What placement needs; one order is created per item. */
export interface PlacementRequest {
  /** The buyer: the account that places the order from its merchant wallet (the portal and Dhru). */
  readonly accountId: number;
  readonly source: PlacedOrderSource;
  /** The merchant key that placed the order (Dhru). */
  readonly apiKeyId?: number | null;
  readonly serviceId: number;
  /** The quantity of each order; the service's minimum when left out. */
  readonly quantity?: number | undefined;
  readonly items: readonly PlacementItem[];
  /** The uploaded input file of a File service. */
  readonly fileId?: number | undefined;
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
 * event, the hold and the outbox job". The buyer is an account; it is locked `FOR KEY SHARE` first (decision 064), and an account of a
 * retail rank (403 `RANK_NOT_ALLOWED`), one that may not act (403 `ACCOUNT_SUSPENDED`) or one whose merchant wallet is frozen (409
 * `WALLET_FROZEN`) is refused before anything is written, so a rank change that races the placement is either seen or waited for.
 * Rules (the brief): the price is the resolver's for this merchant; an order more than the
 * tolerance above the price the merchant last saw is refused (`409 PRICE_CHANGED`, user rule 9), a smaller raise is charged and
 * recorded in `pricing_snapshot`; a second open order for the same service and input is refused under `duplicate_rule =
 * block_open` (`409 DUPLICATE_ORDER`, catalog-2); `orders.imei` holds the main input (orders-suppliers-2, `mainInputOf`). Decision 073: the
 * service type `imei` forces nothing: every custom field is judged by its own type (a field of type `imei` holds one IMEI, read as digits
 * and Luhn-checked on any service), Required tick and pattern; an `imei` sent with text is the value of the main-input field (or, without
 * one, the main input as typed); `placed_at` and
 * `created_at` are never set, so both take the transaction time (orders-suppliers-1); the first dispatch state is the placement
 * rule's (manual, or pending with a `order.dispatch_requested` row for the dispatch job of feature 6). An archived, disabled or
 * hidden service is not orderable. All items of a request are placed in the caller's one transaction: the first refusal
 * (`INSUFFICIENT_FUNDS` included) undoes the whole request.
 *
 * Side effects (on the caller's transaction): takes the buyer's account row `FOR KEY SHARE`; inserts `orders`, `order_events`,
 * `ledger_transactions` and entries (the hold) and `outbox_events`; takes an advisory lock per duplicate fingerprint.
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
    private readonly directory: AccountDirectory,
    private readonly wallets: AccountWallets,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Places the orders of one request.
   *
   * @param tx the caller's transaction
   * @param request the buyer account, the service and the items
   * @returns the stored orders, in the order of the items
   * @throws {AppError} `NOT_FOUND` / `SERVICE_DISABLED` (the service cannot be ordered), `INVALID_IMEI` (422: a field of type `imei`
   *   that holds no valid IMEI, code `invalid_imei` on `inputs.<key>`, or on the item's IMEI path when the value came as `imei`) or
   *   `VALIDATION_FAILED` (422, with the field), `PRICE_CHANGED`, `DUPLICATE_ORDER` (409), `INSUFFICIENT_FUNDS` (402), `UNAUTHORIZED` (the
   *   account no longer exists), `RANK_NOT_ALLOWED` (403: the account holds a retail rank), `ACCOUNT_SUSPENDED` (403), `WALLET_FROZEN`
   *   (409: its merchant wallet is on hold)
   */
  async place(tx: DbExecutor, request: PlacementRequest): Promise<Order[]> {
    // Decision 064: the account row first (FOR KEY SHARE: a rank change holds it FOR UPDATE), then the rows of the path, then the advisory and
    // ledger locks; the rank and the wallet are read only under it.
    const buyer = await this.directory.lockForKeyShare(tx, request.accountId);
    if (!buyer) throw new AppError('UNAUTHORIZED');
    const refusal = placementRefusal({ rankKind: buyer.rankKind, mayAct: canAct(buyer.status) });
    if (refusal !== undefined) throw new AppError(refusal, { detail: PLACEMENT_REFUSAL_DETAILS[refusal] });
    await this.wallets.assertNotFrozen(asTransaction(tx), buyer.id);
    const entry = await this.catalog.find(tx, { clientId: buyer.id, groupId: buyer.groupId }, request.serviceId);
    if (!entry) throw await this.notOrderable(tx, request.serviceId);
    const { service } = entry;

    const fields = (await serviceFieldsOf(tx, service.id)).map((row): PlacementField => ({
      ...row,
      name: row.supplierKey,
      options: row.options,
    }));
    const quantity = request.quantity ?? service.minQty;
    const file = await this.fileOf(tx, request, service.type);
    const prepared = this.validate(request, service, fields, quantity, file?.filename);

    const resolution = await this.resolver.resolve(tx, {
      serviceId: service.id,
      groupId: buyer.groupId,
      clientId: buyer.id,
    });
    if (!resolution) throw await this.notOrderable(tx, request.serviceId);
    const unit = resolution.price;
    const tolerance = await this.settings.integer(
      PRICE_CHANGE_TOLERANCE_KEY,
      DEFAULT_PRICE_CHANGE_TOLERANCE_PERCENT,
      PRICE_CHANGE_TOLERANCE_BOUNDS,
    );
    const listed = await this.listedPrices.find(tx, buyer.id, service.id);
    const verdict = checkPriceChange(listed?.price ?? null, unit, tolerance, { floorRaised: resolution.clamped });
    if (verdict.outcome === 'refuse') {
      throw new AppError('PRICE_CHANGED', {
        detail: 'The price of this service changed since you last listed it. Refresh the service list and order again.',
        extensions: { listedPrice: verdict.listedPrice.toWire(), currentPrice: verdict.currentPrice.toWire() },
      });
    }
    const snapshot: Record<string, unknown> = {
      source: resolution.source,
      rankId: buyer.groupId,
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
          : this.tokens.lookupHash(
              `order-duplicate:${buyer.id}:${service.id}:${item.mainInput.replace(/\s+/g, '').toLowerCase()}`,
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
      // Codes are claimed per order, after the duplicate check, and only for a service delivered from code stock (decision 069:
      // `claim` reads the flag): a short stock, or any other service, sends the order the usual way.
      const claim = await this.stock.claim(tx, service.id, quantity);
      const begin = claim ? fromStock : start;
      const order = await insertOrder(tx, {
        accountId: buyer.id,
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
      });
      const lines = [
        createdLine(request.source, request.actor),
        holdLine(order.totalPrice, buyer.name),
        ...(begin.dispatchState === 'manual' ? [manualReviewLine()] : []),
      ];
      await insertEvents(tx, eventRows(order.id, lines));
      await this.ledger.hold(tx, order, { type: 'account', id: buyer.id });
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
      accountId: order.accountId,
      source: order.source,
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
    const file = await merchantFileOf(tx, request.accountId, request.fileId);
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
    // A service may define a main-input field (decision 065: the field flagged `isMainInput`, whatever its key and type).
    const box = fields.find((field) => field.isMainInput);
    const prepared = request.items.map((item) => {
      const trimmed = Object.fromEntries(Object.entries(item.inputs).map(([key, value]) => [key, value.trim()]));
      // Decision 065: a Dhru caller names its values by field Name (the list shows Names); they are read as keys before anything is judged.
      // The portal and the shop already send keys.
      const named = request.source === 'dhru' ? inputsByFieldName(fields, trimmed) : { inputs: trimmed, problems: [] };
      problems.push(...named.problems);
      const { inputs } = named;
      let judged: Readonly<Record<string, string>> = inputs;
      let paths: Readonly<Record<string, string>> = {};
      let sentImei: string | undefined;
      if (service.type === 'imei') {
        // Decision 073: the type forces nothing; the form is the custom fields, each judged by its own type, Required tick and pattern. An
        // `imei` sent with text (older shop pages, Dhru's `IMEI`, an item of `imeis`) is the main-input field's value, its problems on the
        // item's IMEI path; without such a field it is taken as typed. Our Dhru list leaves that field out, so a Dhru caller always reads
        // its problems on `IMEI`.
        const bridge = bridgedImeiOf({
          imei: item.imei,
          inputs,
          imeiPath: item.imeiField,
          fieldKey: box?.key,
          onImeiPath: request.source === 'dhru',
        });
        ({ inputs: judged, paths, imei: sentImei } = bridge);
      } else if (item.imei !== undefined) {
        problems.push({
          field: item.imeiField,
          code: 'not_applicable',
          message: 'This service does not take an IMEI.',
        });
      }
      // A field of type `imei` that does not hold a valid IMEI answers `INVALID_IMEI`; every other problem `VALIDATION_FAILED`.
      for (const problem of inputProblems(fields, judged, paths)) {
        (problem.code === 'invalid_imei' ? imeiProblems : problems).push(problem);
      }
      // The values as stored (a field of type `imei` as digits): the main input is read from them, so `orders.imei`, the duplicate
      // check and the supplier's `IMEI` parameter name the same text.
      const values = normalizedInputs(fields, judged);
      // Under the keys the request sent; a bridged `imei` replaces the main-input field's value there, so the order never shows two.
      const stored = normalizedInputs(fields, inputs);
      if (sentImei !== undefined && box && Object.hasOwn(stored, box.key)) stored[box.key] = values[box.key]!;
      return {
        mainInput: mainInputOf({ type: service.type, imei: sentImei, inputs: values, fields, fileName }),
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
