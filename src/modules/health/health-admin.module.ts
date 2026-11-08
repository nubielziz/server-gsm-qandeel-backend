// The System health routes and the dashboard (map domain G, stages 9 and 12): controllers, the use cases behind them, the queue board and the
// API heartbeat; stage 12 adds the alert rules, alerts, incidents and the integrity report. Separate from `HealthModule` so a test app built
// without the database or Redis can leave them out.
import { Module } from '@nestjs/common';
import { MaintenanceModule } from '../platform';
import { AlertNotifierModule } from './alert-notifier.module';
import { AlertRulesService } from './application/alert-rules.service';
import { AlertsService } from './application/alerts.service';
import { ApiHeartbeat } from './application/api-heartbeat';
import { ChecksHistoryService } from './application/checks-history.service';
import { HealthSnapshotService } from './application/health-snapshot.service';
import { IncidentsService } from './application/incidents.service';
import { IntegrityService } from './application/integrity.service';
import { JobsAdminService } from './application/jobs-admin.service';
import { MaintenanceAdminService } from './application/maintenance-admin.service';
import { PipelineHealthService } from './application/pipeline-health.service';
import { PrometheusClient } from './application/prometheus.client';
import { QueueAdminService } from './application/queue-admin.service';
import { StoresHealthService } from './application/stores-health.service';
import { TrafficService } from './application/traffic.service';
import { WebhookIntakeCounter } from './application/webhook-intake.counter';
import { AlertRulesController } from './controllers/alert-rules.controller';
import { AlertsController } from './controllers/alerts.controller';
import { IncidentsController } from './controllers/incidents.controller';
import { IntegrityController } from './controllers/integrity.controller';
import { SystemOpsController } from './controllers/system-ops.controller';
import { SystemOverviewController } from './controllers/system-overview.controller';
import { SystemTrafficController } from './controllers/system-traffic.controller';
import { DashboardController } from './dashboard/dashboard.controller';
import { DashboardService } from './dashboard/dashboard.service';
import { JobRunsModule } from './job-runs/job-runs.module';
import { QueuesBoard } from './queues-board/queues-board';

/**
 * Provides the 17 admin routes of the System health and Dashboard pages, the 14 routes of alert rules, alerts, incidents and the integrity check
 * (feature 12b), and the Bull Board mount.
 *
 * Why: the routes read Postgres, both Redis roles and Prometheus through the global database, cache, queue and platform providers
 * (all imported by the API's root module). `WebhookIntakeCounter` is exported for the billing feature's callback handler. Switching a rule off or deleting
 * it resolves its open alerts, so the rule service writes the "resolved" messages through the notification feature (`AlertNotifierModule`).
 */
@Module({
  imports: [JobRunsModule, MaintenanceModule, AlertNotifierModule],
  controllers: [
    SystemOverviewController,
    SystemOpsController,
    SystemTrafficController,
    DashboardController,
    AlertRulesController,
    AlertsController,
    IncidentsController,
    IntegrityController,
  ],
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
    AlertRulesService,
    AlertsService,
    IncidentsService,
    IntegrityService,
    ApiHeartbeat,
    QueuesBoard,
  ],
  exports: [WebhookIntakeCounter],
})
export class HealthAdminModule {}
