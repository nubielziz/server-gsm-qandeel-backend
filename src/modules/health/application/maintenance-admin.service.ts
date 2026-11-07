// `PUT /admin/system/maintenance`: switches maintenance mode through the platform's `MaintenanceService` state and the settings key
// `maintenance`, audited (docs/contract/endpoints/health.md, MISMATCHES B67).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { getRequestContext } from '../../../common/request-context';
import { CacheKeys, CacheService } from '../../../infra/cache';
import { DbService } from '../../../infra/db';
import {
  AuditService,
  MAINTENANCE_KEY,
  MAINTENANCE_OFF,
  type MaintenanceScope,
  type MaintenanceState,
  MaintenanceService,
  parseMaintenanceState,
} from '../../platform';
import { SettingsService } from '../../platform';

/** The body of the route, after validation. */
export type MaintenanceChange =
  { enabled: true; scope: MaintenanceScope; message: string; expectedEndAt: string | null } | { enabled: false };

/**
 * Changes the maintenance state.
 *
 * Why: staff close the storefront, checkouts or merchant API orders during an incident or a deploy; the admin console is never
 * affected. Enabling while on changes scope, message and end but keeps who started it and when; switching off resets the rest. The
 * state is stored as `GET /admin/system/health` returns it, so the banner reads it back unchanged.
 *
 * Side effects: upserts the settings key `maintenance` and writes one `audit_logs` row in one transaction; after the commit it clears
 * the maintenance state cache (the pipeline hook sees the change within about a second) and the cached health snapshot.
 */
@Injectable()
export class MaintenanceAdminService {
  constructor(
    private readonly db: DbService,
    private readonly settings: SettingsService,
    private readonly maintenance: MaintenanceService,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Applies a change.
   *
   * @param staffId the staff member who asked
   * @param change the new state
   * @returns the stored state
   * @throws {AppError} `VALIDATION_FAILED` (field `expectedEndAt`) when the expected end is not in the future
   */
  async set(staffId: number, change: MaintenanceChange): Promise<MaintenanceState> {
    const now = this.clock.now();
    if (change.enabled && change.expectedEndAt !== null && new Date(change.expectedEndAt) <= now) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'expectedEndAt', code: 'invalid', message: 'The expected end must be in the future.' }],
      });
    }
    return this.db.runInTransaction(async (work) => {
      const before = parseMaintenanceState(await this.settings.get(MAINTENANCE_KEY, work.tx)) ?? MAINTENANCE_OFF;
      const after: MaintenanceState = change.enabled
        ? {
            enabled: true,
            scope: change.scope,
            message: change.message,
            expectedEndAt: change.expectedEndAt === null ? null : new Date(change.expectedEndAt).toISOString(),
            startedAt: before.enabled && before.startedAt ? before.startedAt : now.toISOString(),
            startedBy:
              before.enabled && before.startedBy
                ? before.startedBy
                : { id: staffId, name: getRequestContext()?.actor?.name || `Staff #${staffId}` },
          }
        : MAINTENANCE_OFF;
      await this.settings.set(work.tx, MAINTENANCE_KEY, after);
      work.afterCommit(() => this.maintenance.invalidate());
      work.afterCommit(async () => {
        await this.cache.del(this.keys.healthSnapshot());
      });
      await this.audit.record(work.tx, {
        action: !change.enabled
          ? 'turned off maintenance'
          : before.enabled
            ? 'changed maintenance'
            : 'turned on maintenance',
        entityType: 'setting',
        entityLabel: MAINTENANCE_KEY,
        before: { ...before },
        after: { ...after },
      });
      return after;
    });
  }
}
