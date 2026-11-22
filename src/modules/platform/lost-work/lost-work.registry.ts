// LostWorkRegistry: the passes of the lost-work reconcile that the owning modules register (platform module, decision 055).
import { Injectable } from '@nestjs/common';
import type { LostWorkPass } from './lost-work.types';

const KIND = /^[a-z][a-z_]{1,40}$/;

/**
 * Holds the lost-work passes.
 *
 * Why: decision 055: each module knows which of its rows wait for a job; the platform runs them. It is provided by the global
 * `OutboxModule`, so a module that registers a pass (in `onModuleInit`) needs no new import.
 */
@Injectable()
export class LostWorkRegistry {
  private readonly passes = new Map<string, LostWorkPass>();

  /**
   * Adds a pass.
   *
   * @param pass the pass
   * @throws {Error} when the kind is not 2 to 41 lower case letters and "_", or a pass of the same kind is registered already
   */
  register(pass: LostWorkPass): void {
    if (!KIND.test(pass.kind))
      throw new Error(`Lost-work pass kind "${pass.kind}" must be lower case letters and "_".`);
    if (this.passes.has(pass.kind)) throw new Error(`A lost-work pass of kind "${pass.kind}" is already registered.`);
    this.passes.set(pass.kind, pass);
  }

  /**
   * Lists the passes.
   *
   * @returns the passes in registration order
   */
  list(): readonly LostWorkPass[] {
    return [...this.passes.values()];
  }
}
