// Nest module that provides the Clock and the Timers to every module (decision 031). Imported once by the root modules of the
// API and the worker.
import { Global, Module } from '@nestjs/common';
import { CLOCK, SystemClock, TIMERS, systemTimers } from './clock';

/**
 * Provides the {@link CLOCK} token with the real {@link SystemClock} and the {@link TIMERS} token with the real timers.
 *
 * Why: decision 031. It is global so a module injects them without importing anything; tests replace the providers
 * with a `TestClock` and `ManualTimers` (`createTestApp({ clock, timers })`, `createInfra({ clock, timers })`).
 */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: TIMERS, useValue: systemTimers },
  ],
  exports: [CLOCK, TIMERS],
})
export class ClockModule {}
