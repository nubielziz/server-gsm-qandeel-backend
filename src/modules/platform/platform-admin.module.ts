// The platform routes of stage 2 (audit log, settings): controllers and the use cases behind them. Separate from the global
// modules so a test app built without a database can leave them out.
import { Module } from '@nestjs/common';
import { AuditLogAdminService } from './application/audit-log-admin.service';
import { SettingsAdminService } from './application/settings-admin.service';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { AuditLogsController } from './controllers/audit-logs.controller';
import { SettingsController } from './controllers/settings.controller';

/**
 * Provides `/admin/audit-logs` and `/admin/settings`.
 *
 * Why: the routes read and write Postgres through the global database, settings and audit providers (all imported by the
 * API's root module) and clear the maintenance cache through `MaintenanceModule`; the module is exported to the rest of the app
 * only through `index.ts`.
 */
@Module({
  imports: [MaintenanceModule],
  controllers: [AuditLogsController, SettingsController],
  providers: [AuditLogAdminService, SettingsAdminService],
})
export class PlatformAdminModule {}
