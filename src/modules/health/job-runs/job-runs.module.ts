// Nest module of JobRunsService (health module, decision 020). Import it where jobs record their runs: the worker's root
// module, and later the health feature's routes. It is separate from HealthModule so that the worker does not load the
// health controllers.
import { Module } from '@nestjs/common';
import { JOB_RUN_RECORDER } from '../../platform';
import { JobRunsService } from './job-runs.service';

/**
 * Provides {@link JobRunsService}.
 *
 * Why: processors in other modules wrap their scheduled work with it (`src/modules/health/index.ts` exports the module
 * and the service); it needs only the global database module.
 */
@Module({
  // Feature 23 (S8): platform jobs record their runs through this port, since platform cannot import health.
  providers: [JobRunsService, { provide: JOB_RUN_RECORDER, useExisting: JobRunsService }],
  exports: [JobRunsService, JOB_RUN_RECORDER],
})
export class JobRunsModule {}
