// SettingsAdminService: the use cases of the system settings routes (map domain G, stage 2): read the flat settings object and
// change the keys of the settings registry.
import { Injectable } from '@nestjs/common';
import type { JsonValue } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { AuditService } from '../audit/audit.service';
import { isSecretKey } from '../audit/audit-redaction';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { SettingsReader } from '../settings/settings-reader';
import { settingsPatchProblems } from '../settings/settings-registry';
import { loadAllSettings } from '../settings/settings.repository';
import { SettingsService } from '../settings/settings.service';

/**
 * Drops the keys whose names mark a secret: the console shows the rest, and a secret is never readable back. Values come from
 * a jsonb column, so they are JSON; the cast only names that.
 */
function publicSettings(all: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(all).filter(([key]) => !isSecretKey(key))) as Record<string, JsonValue>;
}

/**
 * Reads and changes the system settings.
 *
 * Why: RESOLUTIONS identity-platform-13. `PATCH /admin/settings` is an allow-list: only the keys of the settings registry, each
 * with its validator, so `settings:update` cannot bypass the routes that guard the other keys (`adminAllowlistOnly`,
 * `maintenance`, risk rules, storefront policies; MISMATCHES B67). Every other key is `422` with `errors[].field` = the key.
 *
 * Side effects: upserts `settings` rows and writes one `audit_logs` row with the before and after of the changed keys; after the
 * commit it clears the settings snapshot (`SettingsReader.invalidate()`) and the maintenance state cache. No allowed key feeds
 * the IP rule cache; a key added to the registry that does must also clear `IpRuleCache` (identity module) after its commit.
 *
 * @see docs/contract/endpoints/platform.md (GET and PATCH /admin/settings)
 */
@Injectable()
export class SettingsAdminService {
  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsService,
    private readonly reader: SettingsReader,
    private readonly maintenance: MaintenanceService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Reads the settings.
   *
   * @returns the flat object of every non-secret setting
   */
  async get(): Promise<Record<string, JsonValue>> {
    return publicSettings(await loadAllSettings(this.db.db));
  }

  /**
   * Changes allow-listed settings.
   *
   * @param patch the flat object of keys to set
   * @returns the whole settings object after the change
   * @throws {AppError} `VALIDATION_FAILED` (422) with one `errors[]` item per refused key (`field` = the key)
   */
  async update(patch: Readonly<Record<string, unknown>>): Promise<Record<string, JsonValue>> {
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'body', code: 'empty', message: 'Send at least one setting.' }],
      });
    }
    const problems = settingsPatchProblems(patch);
    if (problems.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        errors: problems.map((problem) => ({ field: problem.key, code: 'invalid', message: problem.message })),
      });
    }
    return this.db.runInTransaction(async (work) => {
      const before: Record<string, unknown> = {};
      for (const key of keys) before[key] = (await this.settings.set(work.tx, key, patch[key])) ?? null;
      work.afterCommit(() => this.reader.invalidate());
      work.afterCommit(() => this.maintenance.invalidate());
      await this.audit.record(work.tx, {
        action: 'changed settings',
        entityType: 'setting',
        entityLabel: keys.join(', '),
        before,
        after: { ...patch },
      });
      return publicSettings(await loadAllSettings(work.tx));
    });
  }
}
