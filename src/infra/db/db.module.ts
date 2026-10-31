// Global Nest module for Postgres (decision 005): provides DbService and registers the critical `postgres` health check.
// Shared by the API and the worker; migrations never run here (`bun run db:migrate`, decision 027).
import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { HealthRegistry, HealthRegistryModule } from '../health';
import { DbService } from './db.service';
import { PostgresHealthIndicator } from './postgres.health';

/**
 * Provides {@link DbService} to every module and registers the Postgres health indicator.
 *
 * Why: every domain module needs the database; GET /health must report Postgres as critical (map "service health check",
 * decision 015). Registering in `onModuleInit` keeps `src/infra` free of imports from the health module (decision 016).
 */
@Global()
@Module({ imports: [HealthRegistryModule], providers: [DbService], exports: [DbService] })
export class DbModule implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly registry: HealthRegistry,
  ) {}

  /** Registers the `postgres` indicator; the check itself runs only when `/health` is called. */
  onModuleInit(): void {
    this.registry.register(new PostgresHealthIndicator(this.db));
  }
}
