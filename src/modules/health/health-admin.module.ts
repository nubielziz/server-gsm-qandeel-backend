// The System health routes and the dashboard (map domain G, stage 9): controllers, the use cases behind them, the queue board and the
// API heartbeat. Separate from `HealthModule` so a test app built without the database or Redis can leave them out.
import { Module } from '@nestjs/common';
import { MaintenanceModule } from '../platform';
import { ApiHeartbeat } from './application/api-heartbeat';
import { ChecksHistoryService } from './application/checks-history.service';
import { HealthSnapshotService } from './application/health-snapshot.service';
import { JobsAdminService } from './application/jobs-admin.service';
import { MaintenanceAdminService } from './application/maintenance-admin.service';
import { PipelineHealthService } from './application/pipeline-health.service';
import { PrometheusClient } from './application/prometheus.client';
import { QueueAdminService } from './application/queue-admin.service';
import { StoresHealthService } from './application/stores-health.service';
import { TrafficService } from './application/traffic.service';
import { WebhookIntakeCounter } from './application/webhook-intake.counter';
import { SystemOpsController } from './controllers/system-ops.controller';
import { SystemOverviewController } from './controllers/system-overview.controller';
import { SystemTrafficController } from './controllers/system-traffic.controller';
import { DashboardController } from './dashboard/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { JobRunsModule } from './job-runs/job-runs.module';
import { QueuesBoard } from './queues-board/queues-board';

/**
 * Provides the 17 admin routes of the System health and Dashboard pages and the Bull Board mount.
 *
 * Why: the routes read Postgres, both Redis roles and Prometheus through the global database, cache, queue and platform providers
 * (all imported by the API's root module). `WebhookIntakeCounter` is exported for the billing feature's callback handler.
 */
@Module({
  imports: [JobRunsModule, MaintenanceModule],
  controllers: [SystemOverviewController, SystemOpsController, SystemTrafficController, DashboardController],
  providers: [
    PrometheusClient,
    HealthSnapshotService,
    ChecksHistoryService,
    MaintenanceAdminService,
    PipelineHealthService,
    StoresHealthService,
    QueueAdminService,
    JobsAdminService,
    TrafficService,
    WebhookIntakeCounter,
    DashboardService,
    ApiHeartbeat,
    QueuesBoard,
  ],
  exports: [WebhookIntakeCounter],
})
export class HealthAdminModule {}
