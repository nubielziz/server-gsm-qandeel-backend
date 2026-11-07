// The platform routes of stages 2 and 5 (audit log, settings, file downloads): controllers and the use cases behind them. Separate from the global
// modules so a test app built without a database can leave them out.
import { Module } from '@nestjs/common';
import { AuditLogAdminService } from './application/audit-log-admin.service';
import { FileAccessService } from './application/file-access.service';
import { SettingsAdminService } from './application/settings-admin.service';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { AuditLogsController } from './controllers/audit-logs.controller';
import { FilesController } from './controllers/files.controller';
import { SettingsController } from './controllers/settings.controller';

/**
 * Provides `/admin/audit-logs`, `/admin/settings` and the file downloads `/admin/files/:id` and `/client/files/:id`.
 *
 * Why: the routes read and write Postgres through the global database, settings and audit providers (all imported by the
 * API's root module) and clear the maintenance cache through `MaintenanceModule`; the module is exported to the rest of the app
 * only through `index.ts`.
 */
@Module({
  imports: [MaintenanceModule],
  controllers: [AuditLogsController, SettingsController, FilesController],
  providers: [AuditLogAdminService, SettingsAdminService, FileAccessService],
})
export class PlatformAdminModule {}
