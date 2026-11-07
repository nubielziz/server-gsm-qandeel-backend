// OrderExportService: the CSV exports of the order lists (map domain D, stage 5): the staff export of GET /admin/orders/export and the
// merchant's GET /client/orders/export. Counts first, refuses a huge export, audits the staff export and streams the file in batches.
import { Inject, Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { CLOCK, type Clock } from '../../../common/clock';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import { ADMIN_ORDER_CSV_COLUMNS, CLIENT_ORDER_CSV_COLUMNS, csvHeader, csvLine } from '../domain/order-csv';
import {
  type ExportCursor,
  type OrderRow,
  type OrderScope,
  type OrderSort,
  countOrderRows,
  exportOrderRows,
} from '../infra/order-read.repository';
import { ORDER_AUDIT_ACTIONS } from './order-actions.service';

/** The most rows one export may hold (RESOLUTIONS orders-suppliers-19). */
export const MAX_EXPORT_ROWS = 100_000;

/** How many rows one batch of the stream reads. */
export const EXPORT_BATCH_SIZE = 1_000;

/** A file ready to stream. */
export interface OrderExport {
  /** The CSV as a stream of text chunks. */
  readonly stream: Readable;
  /** The number of rows counted before the stream started. */
  readonly rows: number;
}

type ExportQuery = Pick<ParsedListQuery<OrderSort>, 'filters' | 'search' | 'sort'>;

/** The cursor value of the sort key for a row. */
function cursorOf(row: OrderRow, query: ExportQuery): ExportCursor {
  const field = query.sort[0]?.field ?? 'createdAt';
  const { order } = row;
  const value =
    field === 'totalPrice'
      ? order.totalPrice
      : field === 'status'
        ? order.status
        : field === 'id'
          ? String(order.id)
          : order.createdAt.toISOString();
  return { value, id: order.id };
}

/**
 * Exports orders as CSV.
 *
 * Why: RESOLUTIONS orders-suppliers-19 and ANSWERS orders Q12: the matching rows are counted first and more than 100,000 is `422`;
 * every staff export writes `audit_logs`; the file is streamed (batches of 1,000 by keyset paging, so a long export never loads the
 * table and never repeats a row when orders arrive meanwhile). The merchant's file has its own columns and never carries cost or
 * supplier.
 *
 * Side effects: one `audit_logs` row for a staff export (in its own short transaction, before the first byte); reads only otherwise.
 */
@Injectable()
export class OrderExportService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Starts the staff export.
   *
   * @param query the filters, search and sort of the list (the range is ignored: every matching row is exported)
   * @returns the stream and the row count
   * @throws {AppError} `VALIDATION_FAILED` (422) when more than 100,000 orders match
   */
  async forStaff(query: ExportQuery): Promise<OrderExport> {
    const now = this.clock.now();
    const scope: OrderScope = { kind: 'staff' };
    const rows = await this.checkedCount(scope, query, now);
    await this.db.runInTransaction(({ tx }) =>
      this.audit.record(tx, {
        action: ORDER_AUDIT_ACTIONS.export,
        entityType: 'order',
        entityLabel: `${rows} orders`,
        after: {
          rows,
          filters: query.filters.map((filter) => `${filter.field}${filter.op === 'eq' ? '' : `_${filter.op}`}`),
          search: query.search?.text ?? null,
        },
      }),
    );
    return {
      rows,
      stream: this.stream(scope, query, now, ADMIN_ORDER_CSV_COLUMNS, (row) => [
        row.order.id,
        row.order.createdAt.toISOString(),
        row.order.clientId === null ? 'b2c' : 'b2b',
        row.clientName ?? row.customerName,
        row.serviceName,
        row.order.imei ?? '',
        row.order.status,
        row.supplierName,
        row.order.totalPrice,
        row.order.totalCost,
      ]),
    };
  }

  /**
   * Starts the merchant's export of its own orders.
   *
   * @param clientId the signed-in merchant
   * @param query the filters, search and sort of the merchant list
   * @returns the stream and the row count
   * @throws {AppError} `VALIDATION_FAILED` (422) when more than 100,000 orders match
   */
  async forMerchant(clientId: number, query: ExportQuery): Promise<OrderExport> {
    const now = this.clock.now();
    const scope: OrderScope = { kind: 'merchant', clientId };
    const rows = await this.checkedCount(scope, query, now);
    return {
      rows,
      stream: this.stream(scope, query, now, CLIENT_ORDER_CSV_COLUMNS, (row) => [
        row.order.id,
        row.order.createdAt.toISOString(),
        row.serviceName,
        row.order.imei ?? '',
        row.order.quantity,
        row.order.status,
        row.order.totalPrice,
        row.order.currency,
      ]),
    };
  }

  private async checkedCount(scope: OrderScope, query: ExportQuery, now: Date): Promise<number> {
    const rows = await countOrderRows(this.db.db, scope, query, now);
    if (rows > MAX_EXPORT_ROWS) {
      throw new AppError('VALIDATION_FAILED', {
        detail: `Too many rows (${rows}); narrow the filters (max ${MAX_EXPORT_ROWS}).`,
      });
    }
    return rows;
  }

  private stream(
    scope: OrderScope,
    query: ExportQuery,
    now: Date,
    columns: readonly string[],
    cells: (row: OrderRow) => ReadonlyArray<string | number | null>,
  ): Readable {
    const database = this.db.db;
    async function* chunks(): AsyncGenerator<string> {
      yield csvHeader(columns);
      let after: ExportCursor | undefined;
      for (;;) {
        const batch = await exportOrderRows(database, scope, query, now, EXPORT_BATCH_SIZE, after);
        if (batch.length === 0) return;
        yield batch.map((row) => csvLine(cells(row))).join('');
        if (batch.length < EXPORT_BATCH_SIZE) return;
        after = cursorOf(batch[batch.length - 1]!, query);
      }
    }
    return Readable.from(chunks());
  }
}
