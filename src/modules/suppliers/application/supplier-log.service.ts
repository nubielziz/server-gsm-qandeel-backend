// SupplierLogService: the read side of the supplier call log (`/admin/supplier-api-logs`, stage 6).
import { Injectable } from '@nestjs/common';
import type { JsonObject, ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { type SupplierLogListField, findLog, listLogRows } from '../infra/supplier-log.repository';

/** A call of the log as the console reads it (without the bodies). */
export interface SupplierLogView {
  readonly id: number;
  readonly supplierId: number;
  readonly orderId: number | null;
  readonly action: string;
  readonly httpStatus: number;
  readonly durationMs: number;
  readonly error: string;
  readonly createdAt: string;
}

/** A call with its masked request and response. */
export interface SupplierLogDetailView extends SupplierLogView {
  readonly request: JsonObject;
  readonly response: JsonObject;
}

const toView = (row: {
  id: number;
  supplierId: number;
  orderId: number | null;
  action: string;
  httpStatus: number;
  durationMs: number;
  error: string;
  createdAt: Date;
}): SupplierLogView => ({
  id: row.id,
  supplierId: row.supplierId,
  orderId: row.orderId,
  action: row.action,
  httpStatus: row.httpStatus,
  durationMs: row.durationMs,
  error: row.error,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Reads the supplier call log.
 *
 * Why: orders-suppliers-3: the wire never carries null for the status, the time or the error (`0`, `0`, `''` when there was no answer
 * or no failure); the bodies were masked when the call was written (credentials and IMEIs).
 *
 * Side effects: reads only.
 */
@Injectable()
export class SupplierLogService {
  constructor(private readonly db: DbService) {}

  /**
   * Lists calls, newest first by default.
   *
   * @param query the parsed list request
   * @returns the page and the exact total
   */
  async list(query: ParsedListQuery<SupplierLogListField>): Promise<{ rows: SupplierLogView[]; total: number }> {
    const { rows, total } = await listLogRows(this.db.db, query);
    return { rows: rows.map(toView), total };
  }

  /**
   * Reads one call with its bodies.
   *
   * @param id the log row id
   * @returns the call
   * @throws {AppError} `NOT_FOUND`
   */
  async show(id: number): Promise<SupplierLogDetailView> {
    const row = await findLog(this.db.db, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No log row has this id.' });
    // The bodies were written as plain JSON by the driver's redaction.
    return { ...toView(row), request: (row.request ?? {}) as JsonObject, response: (row.response ?? {}) as JsonObject };
  }
}
