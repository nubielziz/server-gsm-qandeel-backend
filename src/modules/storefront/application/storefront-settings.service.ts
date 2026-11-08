// StorefrontSettingsService: changes the storefront policies (feature 16, map `PATCH /admin/storefront/settings`): validates each key, writes the
// settings rows, audits each change and answers the policies as they are now.
import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService, SettingsReader, SettingsService } from '../../platform';
import {
  type BOOLEAN_POLICIES,
  type NUMBER_POLICIES,
  POLICY_KEYS,
  POLICY_LABELS,
  isPolicyKey,
  policyProblem,
} from '../domain/policy-rules';

/** The policies as the route answers: only the keys that have a value. */
export type PolicyValues = Partial<Record<(typeof BOOLEAN_POLICIES)[number], boolean>> &
  Partial<Record<(typeof NUMBER_POLICIES)[number], number>>;

/**
 * Changes the storefront policies.
 *
 * Why: ANSWERS settings Q1 and B68: the Policies tab writes one key per call (a switch at once, a number on blur) to the flat keys of the settings
 * table; the route accepts only the eight policy keys (any other key is `422` on that key) and answers just those keys with their values after the
 * change, which `GET /admin/settings` shows too. Every changed key writes its own audit row in the demo's words (`turned on policy`, `turned off
 * policy`, `changed policy`). A `require3ds` change also flips the risk rule of the same name: that rule belongs to the risk feature (18) and
 * plugs in right after the write.
 *
 * Side effects: upserts `settings` rows and writes one `audit_logs` row per changed key, in one transaction; clears the settings snapshot after
 * the commit.
 *
 * @see docs/contract/endpoints/storefront.md (PATCH /admin/storefront/settings)
 */
@Injectable()
export class StorefrontSettingsService {
  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsService,
    private readonly reader: SettingsReader,
    private readonly audit: AuditService,
  ) {}

  /**
   * Changes policies.
   *
   * @param patch the flat object the console sent
   * @returns the policies that have a value, after the change
   * @throws {AppError} `VALIDATION_FAILED` (422) with one `errors[]` item per refused key (`field` = the key), or for an empty body
   */
  async update(patch: Readonly<Record<string, unknown>>): Promise<PolicyValues> {
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'body', code: 'empty', message: 'Send at least one setting.' }],
      });
    }
    const problems = keys.flatMap((key) => {
      const message = policyProblem(key, patch[key]);
      return message === undefined ? [] : [{ field: key, code: 'invalid', message }];
    });
    if (problems.length > 0)
      throw new AppError('VALIDATION_FAILED', { detail: problems[0]!.message, errors: problems });
    return this.db.runInTransaction(async (work) => {
      for (const key of keys.filter(isPolicyKey)) {
        const value = patch[key] as boolean | number;
        const before = await this.settings.set(work.tx, key, value);
        if (before === value) continue;
        await this.audit.record(work.tx, {
          action: typeof value === 'boolean' ? `turned ${value ? 'on' : 'off'} policy` : 'changed policy',
          entityType: 'setting',
          entityLabel: POLICY_LABELS[key],
          before: { [key]: before ?? null },
          after: { [key]: value },
        });
      }
      work.afterCommit(() => this.reader.invalidate());
      return this.read(work.tx);
    });
  }

  private async read(tx: Parameters<SettingsService['get']>[1]): Promise<PolicyValues> {
    const values: Record<string, boolean | number> = {};
    for (const key of POLICY_KEYS) {
      const value = await this.settings.get(key, tx);
      if (typeof value === 'boolean' || typeof value === 'number') values[key] = value;
    }
    return values;
  }
}
