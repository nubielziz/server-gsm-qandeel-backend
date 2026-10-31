// Nest module of JobRunsService (health module, decision 020). Import it where jobs record their runs: the worker's root
// module, and later the health feature's routes. It is separate from HealthModule so that the worker does not load the
// health controllers.
import { Module } from '@nestjs/common';
import { JobRunsService } from './job-runs.service';

/**
 * Provides {@link JobRunsService}.
 *
 * Why: processors in other modules wrap their scheduled work with it (`src/modules/health/index.ts` exports the module
 * and the service); it needs only the global database module.
 */
@Module({ providers: [JobRunsService], exports: [JobRunsService] })
export class JobRunsModule {}
