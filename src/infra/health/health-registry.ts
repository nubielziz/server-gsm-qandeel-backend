// Registry of health indicators for GET /health (decision 015). It lives in infra so the database and Redis modules
// (src/infra) can register their checks without importing a domain module; the health module only reads it.
import { Injectable, Module } from '@nestjs/common';

/** Overall state: ok, degraded (a non-critical dependency is down) or down (a critical one is). */
export type HealthStatus = 'ok' | 'degraded' | 'down';

/** One dependency check. */
export interface HealthIndicator {
  /** Key in the response `checks` object; lower case with underscores (`postgres`, `redis`, `redis_queue`). */
  readonly name: string;
  /** True when the API cannot work without it: its failure makes the whole status `down`, otherwise `degraded`. */
  readonly critical: boolean;
  /**
   * Probes the dependency. Resolve (or return `true`) when it works; throw, reject or return `false` when it does not.
   * Keep it cheap: it is timed out after a couple of seconds and runs on every health call.
   */
  check(): Promise<boolean | void>;
}

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Holds the indicators `GET /health` runs.
 *
 * Why: the console reads Postgres and Redis state from this one route (map: "service health check: Postgres and
 * Redis"); each infrastructure module registers its own indicator in `onModuleInit`, so health never imports them
 * and `src/infra` never imports a domain module (decision 016).
 */
@Injectable()
export class HealthRegistry {
  private readonly indicators = new Map<string, HealthIndicator>();

  /**
   * Adds an indicator.
   *
   * @param indicator the check to run on every health call
   * @throws {Error} when the name is invalid or already registered (a boot-time programming error)
   */
  register(indicator: HealthIndicator): void {
    if (!NAME_PATTERN.test(indicator.name))
      throw new Error(`Health indicator name "${indicator.name}" must match ${NAME_PATTERN}`);
    if (this.indicators.has(indicator.name))
      throw new Error(`Health indicator "${indicator.name}" is already registered`);
    this.indicators.set(indicator.name, indicator);
  }

  /** @returns the registered indicators in registration order */
  list(): readonly HealthIndicator[] {
    return [...this.indicators.values()];
  }
}

/**
 * Provides the one {@link HealthRegistry} of the process.
 *
 * Why: infrastructure modules (database, Redis, storage) and the health module import this module; Nest creates a
 * module once per application, so they all share the same registry.
 */
@Module({ providers: [HealthRegistry], exports: [HealthRegistry] })
export class HealthRegistryModule {}
