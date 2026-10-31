// Nest module of maintenance mode (platform module): the cached state and its pipeline hook. API process only.
import { Module } from '@nestjs/common';
import { MaintenanceHook } from './maintenance.hook';
import { MaintenanceService } from './maintenance.service';

/**
 * Provides {@link MaintenanceService} and registers the maintenance stage with the request pipeline.
 *
 * Why: maintenance (scenario system-integrity) is part of the platform module's settings; the hook needs the global
 * pipeline, settings, cache and database modules, which the API's root module imports.
 */
@Module({ providers: [MaintenanceService, MaintenanceHook], exports: [MaintenanceService] })
export class MaintenanceModule {}
