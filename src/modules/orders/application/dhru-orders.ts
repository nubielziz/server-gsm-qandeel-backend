// DhruOrders: the six order actions of the Dhru surface (map domain D, stage 7, decision 026): `placeimeiorder`, `placeimeiorderbulk`,
// `getimeiorder`, `getimeiorderbulk`, `placefileorder` and `getfileorder`. Placement is feature 5's one path, like REST v1 and the portal.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import { type DhruCall, DhruGateway, dhruStatusOf, readCustomFields } from '../../../common/dhru';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { MerchantCatalog } from '../../catalog';
import { FileUploadService } from '../../platform';
import {
  dhruGetFileOrder,
  dhruGetImeiOrder,
  dhruGetImeiOrderBulk,
  dhruPlaceFileOrder,
  dhruPlaceImeiOrder,
  dhruPlaceImeiOrderBulk,
} from '../contracts/dhru.contracts';
import { merchantOf } from '../infra/foreign-reads.repository';
import { findOrderRow } from '../infra/order-read.repository';
import { OrderPlacement } from './order-placement';

type PlaceParams = z.output<NonNullable<(typeof dhruPlaceImeiOrder)['params']>>;
type FileParams = z.output<NonNullable<(typeof dhruPlaceFileOrder)['params']>>;

/** The success entry of a placement: our order id is the `REFERENCEID`. */
const received = (orderId: number) => ({ MESSAGE: 'Order received' as const, REFERENCEID: String(orderId) });

/**
 * Serves the order actions of the Dhru surface.
 *
 * Why: the map's `placeimeiorder`, `placeimeiorderbulk`, `getimeiorder`, `getimeiorderbulk`, `placefileorder` and `getfileorder` rows
 * (scenarios success, reject, manual and timeout, merchant side): a merchant's Dhru software places an order, gets `REFERENCEID` at once
 * (status 0) and later reads `STATUS` and `CODE`. The placement is `OrderPlacement.place` in one transaction per order (source `dhru`, the key's
 * id on the order); a refusal maps to its catalog code and the Dhru formatter words it ("Price changed. Please refresh the service list and
 * order again.", "Not enough credits"). Dhru has no idempotency field: a repeated placement is stopped by the service's duplicate rule
 * (`DUPLICATE_ORDER`). A bulk call places each item on its own (the gateway answers per item). A merchant reads its own orders only.
 * An IMEI service is placed with `placeimeiorder` and a File service with `placefileorder`: the wrong action is refused with a message that
 * names the right one.
 *
 * Side effects: the writes of `OrderPlacement.place` per placement; `placefileorder` stores the file first (object storage and `files`);
 * it binds its six actions to the Dhru gateway at start. No audit row (machine calls of a merchant write none, B121).
 *
 * @see docs/decisions/026-dhru-compatibility.md
 */
@Injectable()
export class DhruOrders implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly placement: OrderPlacement,
    private readonly uploads: FileUploadService,
    private readonly gateway: DhruGateway,
    private readonly catalog: MerchantCatalog,
  ) {}

  /** Binds the six actions to the Dhru gateway. */
  onModuleInit(): void {
    this.gateway.bind(dhruPlaceImeiOrder, (call) => this.placeImei(call));
    this.gateway.bind(dhruPlaceImeiOrderBulk, (call) => this.placeImei(call));
    this.gateway.bind(dhruPlaceFileOrder, (call) => this.placeFile(call));
    this.gateway.bind(dhruGetImeiOrder, (call) => this.status(call.caller.clientId, call.params.ID));
    this.gateway.bind(dhruGetImeiOrderBulk, (call) => this.status(call.caller.clientId, call.params.ID));
    this.gateway.bind(dhruGetFileOrder, async (call) => {
      const status = await this.status(call.caller.clientId, call.params.ID);
      const row = await findOrderRow(this.db.db, { kind: 'merchant', clientId: call.caller.clientId }, call.params.ID);
      const fileId = row?.order.resultFileId ?? null;
      return fileId === null ? status : { ...status, FILEID: fileId };
    });
  }

  /**
   * Places an IMEI, server or remote order.
   *
   * @param call the merchant, the key and the parameters of one order
   * @returns the success entry with the order id as `REFERENCEID`
   * @throws {AppError} see {@link OrderPlacement.place}; `VALIDATION_FAILED` for a File service or custom fields that cannot be read
   */
  private async placeImei(call: DhruCall<PlaceParams>) {
    const { params } = call;
    await this.assertKind(call.caller.clientId, params.ID, 'file-not-allowed');
    const inputs = readCustomFields(params.CUSTOMFIELD);
    return received(await this.place(call, params.ID, params.QNT, { imei: params.IMEI, inputs }));
  }

  /**
   * Places a File service order: the file is stored first, then ordered like any other.
   *
   * @param call the merchant, the key, the parameters and the files of the request
   * @returns the success entry with the order id as `REFERENCEID`
   * @throws {AppError} `VALIDATION_FAILED` for a service that is not a File service or a missing file; `PAYLOAD_TOO_LARGE`;
   *   see {@link OrderPlacement.place}
   */
  private async placeFile(call: DhruCall<FileParams>) {
    const { params } = call;
    await this.assertKind(call.caller.clientId, params.ID, 'file-required');
    const inputs = readCustomFields(params.CUSTOMFIELD);
    const part = call.files[0];
    let upload: { filename: string; mime: string; data: Buffer };
    if (part !== undefined) {
      upload = { filename: params.FILENAME ?? part.filename, mime: part.mime, data: part.data };
    } else if (params.FILEDATA !== undefined && params.FILEDATA !== '') {
      upload = {
        filename: params.FILENAME ?? 'file',
        mime: 'application/octet-stream',
        data: Buffer.from(params.FILEDATA.replace(/ /g, '+'), 'base64'),
      };
    } else {
      throw new AppError('VALIDATION_FAILED', { detail: 'Send the file as FILEDATA (base64) or as a file part.' });
    }
    const file = await this.uploads.upload(call.caller.clientId, upload);
    return received(await this.place(call, params.ID, params.QNT, { imei: undefined, inputs }, file.id));
  }

  /** Places one order in its own transaction. */
  private async place(
    call: DhruCall<unknown>,
    serviceId: number,
    quantity: number | undefined,
    item: { imei: string | undefined; inputs: Record<string, string> },
    fileId?: number,
  ): Promise<number> {
    const { caller } = call;
    const [order] = await this.db.runInTransaction(({ tx }) =>
      this.placement.place(tx, {
        clientId: caller.clientId,
        source: 'dhru',
        apiKeyId: caller.keyId,
        serviceId,
        quantity,
        items: [{ imei: item.imei, inputs: item.inputs, imeiField: 'IMEI' }],
        fileId,
        actor: { type: 'client', id: caller.clientId },
      }),
    );
    return order!.id;
  }

  /**
   * Refuses the wrong placement action for a service the merchant may order.
   *
   * Why: only a service visible to the merchant's group may say which action it takes; an unknown, archived, disabled or hidden
   * one is left to the placement, which answers `NOT_FOUND` for all of them alike, so a hidden service's existence and type never
   * leak through this message.
   *
   * @param clientId the merchant behind the key
   * @param serviceId the service id of the call
   * @param rule `file-not-allowed`: `placeimeiorder` for a File service; `file-required`: `placefileorder` for any other
   */
  private async assertKind(
    clientId: number,
    serviceId: number,
    rule: 'file-not-allowed' | 'file-required',
  ): Promise<void> {
    const merchant = await merchantOf(this.db.db, clientId);
    if (!merchant) return;
    const entry = await this.catalog.find(this.db.db, { clientId: merchant.id, groupId: merchant.groupId }, serviceId);
    if (!entry) return;
    const { service } = entry;
    if (rule === 'file-not-allowed' && service.type === 'file') {
      throw new AppError('VALIDATION_FAILED', { detail: 'This service takes a file: place it with placefileorder.' });
    }
    if (rule === 'file-required' && service.type !== 'file') {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'This service does not take a file: place it with placeimeiorder.',
      });
    }
  }

  /**
   * Reads the status and result of one of the merchant's orders.
   *
   * @param clientId the merchant behind the key
   * @param orderId the order id (`REFERENCEID`)
   * @returns `STATUS` (0 new, 1 in process, 3 rejected, 4 completed) and `CODE` (the result or the reason; `""` while it runs)
   * @throws {AppError} `NOT_FOUND` ("Order not found") for an unknown id or another merchant's order
   */
  private async status(clientId: number, orderId: number): Promise<{ STATUS: 0 | 1 | 3 | 4; CODE: string }> {
    const row = await findOrderRow(this.db.db, { kind: 'merchant', clientId }, orderId);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Order not found' });
    return { STATUS: dhruStatusOf(row.order.status), CODE: row.order.resultCode ?? '' };
  }
}
