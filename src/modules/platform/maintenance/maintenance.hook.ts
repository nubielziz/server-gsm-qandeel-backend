// The maintenance stage of the request pipeline (decision 018, scenario system-integrity): the chosen scope answers 503
// MAINTENANCE before authentication; the admin console, health and metrics are never affected.
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { LogThrottle } from '../../../common/log-throttle';
import { RequestPipeline, requestPath } from '../../../common/pipeline';
import { MaintenanceService } from './maintenance.service';
import {
  DHRU_PATH,
  MAINTENANCE_OFF,
  type MaintenanceState,
  dhruActionOf,
  maintenanceRefusal,
} from './maintenance-state';

const WARN_INTERVAL_MS = 30_000;

/**
 * Registers the maintenance stage with the pipeline.
 *
 * Why: when staff switch maintenance on for a scope, requests in that scope answer `503 MAINTENANCE` (problem+json with the
 * message, `expectedEndAt` and `Retry-After`; the Dhru envelope on `/api/index.php` through the error formatter seam,
 * decision 026) before they reach authentication or any handler. Most scopes are decided from the method and path in
 * `onRequest`; a Dhru order placement is only known from the `action` field of the body, so it is decided in
 * `preValidation`, after the body is parsed and still before any guard.
 *
 * Failure policy: if the state cannot be read at all, the request goes on (maintenance is a courtesy to customers, not a
 * security rule, and a settings outage must not take the storefront down).
 *
 * Side effects: none of its own; reads the cached state.
 */
@Injectable()
export class MaintenanceHook implements OnModuleInit {
  private readonly logger = new Logger(MaintenanceHook.name);
  private readonly throttle = new LogThrottle(WARN_INTERVAL_MS);

  constructor(
    private readonly pipeline: RequestPipeline,
    private readonly maintenance: MaintenanceService,
  ) {}

  /** Registers the two phases of the stage. */
  onModuleInit(): void {
    this.pipeline.register('maintenance', (request) => this.checkPath(request));
    this.pipeline.register('maintenance', (request) => this.checkDhruAction(request), 'preValidation');
  }

  /** Refuses the requests whose scope is decided by method and path. */
  private async checkPath(request: FastifyRequest): Promise<void> {
    const path = requestPath(request);
    if (path === DHRU_PATH) return; // decided once the action is known
    await this.refuseIfCovered(request, path, undefined);
  }

  /** Refuses a Dhru order placement (the action is in the body). */
  private async checkDhruAction(request: FastifyRequest): Promise<void> {
    const path = requestPath(request);
    if (path !== DHRU_PATH) return;
    await this.refuseIfCovered(request, path, dhruActionOf(request.body));
  }

  private async refuseIfCovered(request: FastifyRequest, path: string, dhruAction: string | undefined): Promise<void> {
    const state = await this.stateOrOff();
    const refusal = maintenanceRefusal(state, { method: request.method, path, dhruAction });
    if (refusal) throw refusal;
  }

  private async stateOrOff(): Promise<MaintenanceState> {
    try {
      return await this.maintenance.state();
    } catch (error) {
      if (this.throttle.attempt('unreadable')) {
        this.logger.warn(`Maintenance state cannot be read; letting requests through: ${String(error)}`);
      }
      return MAINTENANCE_OFF;
    }
  }
}
