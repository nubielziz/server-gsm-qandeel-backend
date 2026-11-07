// ServicePartsService: the replace-all use cases of the custom fields and the option lists of a service
// (PUT /admin/services/:id/fields and /options, map domain B, stage 4).
import { Injectable } from '@nestjs/common';
import { AppError, type FieldError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../../platform';
import type { ServiceFieldType, ServiceOptionList } from '../db/schema';
import { duplicateFieldKeys, duplicateOptionValues, isValidPattern } from '../domain/service-parts';
import {
  listFieldRows,
  listOptionRows,
  lockLiveService,
  replaceFieldRows,
  replaceOptionRows,
} from '../infra/service.repository';
import { type FieldView, type OptionView, toFieldView, toOptionView } from './service-admin.service';

/** One custom field as the console sends it (already trimmed by the contract). */
export interface FieldInput {
  readonly key: string;
  readonly label: string;
  readonly fieldType: ServiceFieldType;
  readonly required: boolean;
  readonly options: string[];
  readonly regex: string;
  readonly supplierKey: string;
}

/** One option entry as the console sends it (already trimmed by the contract). */
export interface OptionInput {
  readonly list: ServiceOptionList;
  readonly value: string;
  readonly label: string;
  readonly supplierValue: string;
}

function problems(list: ReadonlyArray<{ field: string; message: string }>): AppError {
  const errors: FieldError[] = list.map((item) => ({ field: item.field, code: 'invalid', message: item.message }));
  return new AppError('VALIDATION_FAILED', { errors });
}

const notFound = () => new AppError('NOT_FOUND', { detail: 'No service has this id.' });

const countsByList = (options: ReadonlyArray<{ list: string }>) => ({
  model: options.filter((option) => option.list === 'model').length,
  network: options.filter((option) => option.list === 'network').length,
  mep: options.filter((option) => option.list === 'mep').length,
});

/**
 * Replaces the lists that hang on a service.
 *
 * Why: the console edits custom fields and option lists as whole lists (RULES services 8): the old rows are deleted and the
 * new list inserted in order in one transaction, under a lock on the service row so two saves cannot interleave, and the saved
 * list is answered back. An unknown or archived service is `404`. Duplicate keys or values answer `422` on the later row's path
 * (RESOLUTIONS catalog-11); no unique violation can happen, because the lock serialises the writers.
 *
 * Side effects: deletes and inserts `service_fields` or `service_options`, writes `audit_logs` (entity `service`).
 *
 * @see docs/contract/endpoints/catalog.md (PUT /admin/services/:id/fields and /options)
 */
@Injectable()
export class ServicePartsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Replaces the custom fields of a service.
   *
   * @param serviceId the service id
   * @param fields the whole list in order (the index is the sort order)
   * @returns the saved fields in order
   * @throws {AppError} `NOT_FOUND` (404: unknown or archived); `VALIDATION_FAILED` (422 on `fields.N.key` for a repeated key,
   *   on `fields.N.regex` for a pattern that does not compile)
   */
  async replaceFields(serviceId: number, fields: readonly FieldInput[]): Promise<FieldView[]> {
    return this.db.runInTransaction(async ({ tx }) => {
      const service = await lockLiveService(tx, serviceId);
      if (!service) throw notFound();
      const found = [
        ...duplicateFieldKeys(fields.map((field) => field.key)),
        ...fields.flatMap((field, index) =>
          isValidPattern(field.regex)
            ? []
            : [{ field: `fields.${index}.regex`, message: 'Enter a valid regular expression.' }],
        ),
      ];
      if (found.length > 0) throw problems(found);

      const before = await listFieldRows(tx, serviceId);
      const saved = await replaceFieldRows(tx, serviceId, fields);
      await this.audit.record(tx, {
        action: 'replaced custom fields of service',
        entityType: 'service',
        entityId: serviceId,
        entityLabel: service.name,
        before: { fields: before.map((field) => field.key) },
        after: { fields: saved.map((field) => field.key) },
      });
      return saved.map(toFieldView);
    });
  }

  /**
   * Replaces the model, network and MEP lists of a service.
   *
   * @param serviceId the service id
   * @param options all three lists together, in order
   * @returns the saved entries in order
   * @throws {AppError} `NOT_FOUND` (404: unknown or archived); `VALIDATION_FAILED` (422 on `options.N.value` for a value
   *   repeated within its list)
   */
  async replaceOptions(serviceId: number, options: readonly OptionInput[]): Promise<OptionView[]> {
    return this.db.runInTransaction(async ({ tx }) => {
      const service = await lockLiveService(tx, serviceId);
      if (!service) throw notFound();
      const found = duplicateOptionValues(options);
      if (found.length > 0) throw problems(found);

      const before = await listOptionRows(tx, serviceId);
      const saved = await replaceOptionRows(tx, serviceId, options);
      await this.audit.record(tx, {
        action: 'replaced option lists of service',
        entityType: 'service',
        entityId: serviceId,
        entityLabel: service.name,
        before: countsByList(before),
        after: countsByList(saved),
      });
      return saved.map(toOptionView);
    });
  }
}
