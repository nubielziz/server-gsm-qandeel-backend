// ServicePartsService: the replace-all use cases of the custom fields and the option lists of a service
// (PUT /admin/services/:id/fields and /options, map domain B, stage 4).
import { Injectable } from '@nestjs/common';
import { AppError, type FieldError } from '../../../common/errors';
import { fieldPatternProblem } from '../../../common/field-pattern';
import { DbService, isUniqueViolation } from '../../../infra/db';
import { AuditService } from '../../platform';
import { CatalogSignals } from './catalog-signals';
import type { ServiceField, ServiceOptionList } from '../db/schema';
import { type FieldDraft, duplicateOptionValues, fieldListProblems, plannedFieldRows } from '../domain/service-parts';
import { laterRepeatedNameIndexes } from '../infra/field-name.repository';
import {
  listFieldRows,
  listOptionRows,
  lockLiveService,
  replaceFieldRows,
  replaceOptionRows,
} from '../infra/service.repository';
import { type FieldView, type OptionView, toFieldView, toOptionView } from './service-admin.service';

/**
 * One custom field as the console sends it (already trimmed by the contract): the `key` of a saved field or none for a new one, the
 * Name, an optional label and an optional main-input flag.
 */
export type FieldInput = FieldDraft;

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

/**
 * What the audit row of a fields save says about one field: the main-input flag decides what travels as the IMEI parameter, and the Name,
 * label and `required` what a supplier and a buyer see (decision 065).
 */
const auditedField = (field: ServiceField) => ({
  key: field.key,
  name: field.supplierKey,
  label: field.label,
  required: field.required,
  isMainInput: field.isMainInput,
});

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
 * list is answered back. An unknown or archived service is `404`. Duplicate keys, Names or values answer `422` on the later row's
 * path (RESOLUTIONS catalog-11, decision 065); no unique violation can happen, because the lock serialises the writers, except a Name
 * that the code and the database lower-case differently (answered `422` on `fields.N.name` as well).
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
    private readonly signals: CatalogSignals,
  ) {}

  /**
   * Replaces the custom fields of a service.
   *
   * A row that names a saved field keeps that field's key; a row without a key is a new field and gets a key made from its Name; the
   * Name is stored as the field's `supplier_key` (decision 065). On an IMEI service a list that leaves no field flagged as the main input
   * flags the first field named IMEI in any letter case. The audit row names each field before and after by key, Name, label,
   * `required` and the main-input flag.
   *
   * @param serviceId the service id
   * @param fields the whole list in order (the index is the sort order)
   * @returns the saved fields in order
   * @throws {AppError} `NOT_FOUND` (404: unknown or archived); `VALIDATION_FAILED` (422 on `fields.N.key` for an unknown or repeated
   *   key, on `fields.N.name` for a Name an earlier field has ignoring letter case, on `fields.N.isMainInput` for a second main
   *   input, on `fields.N.regex` for a pattern outside the supported form, decision 051)
   */
  async replaceFields(serviceId: number, fields: readonly FieldInput[]): Promise<FieldView[]> {
    return this.db
      .runInTransaction(async ({ tx }) => {
        const service = await lockLiveService(tx, serviceId);
        if (!service) throw notFound();
        const before = await listFieldRows(tx, serviceId);
        const found = [
          ...fieldListProblems(
            fields,
            new Set(before.map((field) => field.key)),
            new Set(before.filter((field) => field.isMainInput).map((field) => field.key)),
          ),
          ...fields.flatMap((field, index) => {
            const problem = fieldPatternProblem(field.regex);
            return problem === undefined ? [] : [{ field: `fields.${index}.regex`, message: problem.message }];
          }),
        ];
        if (found.length > 0) throw problems(found);

        const saved = await replaceFieldRows(tx, serviceId, plannedFieldRows(fields, before, service.type === 'imei'));
        await this.audit.record(tx, {
          action: 'replaced custom fields of service',
          entityType: 'service',
          entityId: serviceId,
          entityLabel: service.name,
          before: { fields: before.map(auditedField) },
          after: { fields: saved.map(auditedField) },
        });
        return saved.map(toFieldView);
      })
      .catch(async (error: unknown) => {
        // The code and the database may lower-case a letter differently: the unique index has the last word on a repeated Name.
        if (isUniqueViolation(error, 'service_fields_name_uq')) {
          const later = await laterRepeatedNameIndexes(
            this.db.db,
            fields.map((field) => field.name.trim()),
          );
          if (later.length > 0) {
            throw problems(
              later.map((index) => ({
                field: `fields.${index}.name`,
                message: `The name ${fields[index]?.name.trim() ?? ''} is used by an earlier field.`,
              })),
            );
          }
        }
        throw error;
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
      // The model and network labels are indexed by the shop's search (feature 29).
      await this.signals.servicesChanged(tx, [serviceId], 'options');
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
