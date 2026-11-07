// HTTP controller of the System health overview and store routes (map domain G, stage 9): health, checks, maintenance, orders and
// supplier health, database, cache and webhooks. Thin: the rules live in the services of `application/`.
import { Body, Controller, Query } from '@nestjs/common';
import { type BodyOf, type QueryOf, type ResultOf, Route } from '../../../common/contract';
import { CurrentStaff, type StaffPrincipal } from '../../identity';
import { ChecksHistoryService } from '../application/checks-history.service';
import { HealthSnapshotService } from '../application/health-snapshot.service';
import { MaintenanceAdminService } from '../application/maintenance-admin.service';
import { PipelineHealthService } from '../application/pipeline-health.service';
import { StoresHealthService } from '../application/stores-health.service';
import { getChecks, getSystemHealth, setMaintenance } from '../contracts/system-health.contracts';
import {
  getCacheHealth,
  getDatabaseHealth,
  getOrdersHealth,
  getSuppliersHealth,
} from '../contracts/system-pipeline.contracts';
import { getWebhooksHealth } from '../contracts/system-ops.contracts';

/**
 * The System health overview routes.
 *
 * Why: the console's System health page and the maintenance banner of every admin page read these.
 *
 * @route GET /admin/system/health
 * @route GET /admin/system/checks
 * @route PUT /admin/system/maintenance
 * @route GET /admin/system/orders-health
 * @route GET /admin/system/suppliers
 * @route GET /admin/system/database
 * @route GET /admin/system/cache
 * @route GET /admin/system/webhooks
 */
@Controller()
export class SystemOverviewController {
  constructor(
    private readonly snapshot: HealthSnapshotService,
    private readonly history: ChecksHistoryService,
    private readonly maintenance: MaintenanceAdminService,
    private readonly pipeline: PipelineHealthService,
    private readonly stores: StoresHealthService,
  ) {}

  /**
   * The overall status with every component.
   *
   * @returns the snapshot
   * @route GET /admin/system/health
   */
  @Route(getSystemHealth)
  health(): Promise<ResultOf<typeof getSystemHealth>> {
    return this.snapshot.get() as Promise<ResultOf<typeof getSystemHealth>>;
  }

  /**
   * The check history.
   *
   * @param query the range and an optional component
   * @returns buckets and uptime per component
   * @route GET /admin/system/checks
   */
  @Route(getChecks)
  checks(@Query() query: QueryOf<typeof getChecks>): Promise<ResultOf<typeof getChecks>> {
    return this.history.history(query.range, query.component) as Promise<ResultOf<typeof getChecks>>;
  }

  /**
   * Switches maintenance mode.
   *
   * @param staff the signed-in staff member
   * @param body the new state
   * @returns the stored state
   * @route PUT /admin/system/maintenance
   */
  @Route(setMaintenance)
  setMaintenance(
    @CurrentStaff() staff: StaffPrincipal,
    @Body() body: BodyOf<typeof setMaintenance>,
  ): Promise<ResultOf<typeof setMaintenance>> {
    return this.maintenance.set(staff.staffId, body);
  }

  /**
   * The order pipeline health.
   *
   * @returns past-SLA orders and outcomes
   * @route GET /admin/system/orders-health
   */
  @Route(getOrdersHealth)
  ordersHealth(): Promise<ResultOf<typeof getOrdersHealth>> {
    return this.pipeline.ordersHealth();
  }

  /**
   * The supplier health.
   *
   * @returns one row per supplier
   * @route GET /admin/system/suppliers
   */
  @Route(getSuppliersHealth)
  suppliers(): Promise<ResultOf<typeof getSuppliersHealth>> {
    return this.pipeline.suppliersHealth();
  }

  /**
   * Postgres health.
   *
   * @returns connections, locks, size, migrations, slow queries
   * @route GET /admin/system/database
   */
  @Route(getDatabaseHealth)
  database(): Promise<ResultOf<typeof getDatabaseHealth>> {
    return this.stores.database();
  }

  /**
   * Cache Redis health.
   *
   * @returns memory, evictions, hit rate, clients, latency
   * @route GET /admin/system/cache
   */
  @Route(getCacheHealth)
  cache(): Promise<ResultOf<typeof getCacheHealth>> {
    return this.stores.cache();
  }

  /**
   * Webhook delivery health.
   *
   * @returns outgoing and incoming delivery figures
   * @route GET /admin/system/webhooks
   */
  @Route(getWebhooksHealth)
  webhooks(): Promise<ResultOf<typeof getWebhooksHealth>> {
    return this.pipeline.webhooksHealth();
  }
}
