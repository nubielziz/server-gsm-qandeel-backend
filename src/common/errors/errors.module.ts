// Global module that installs the problem+json exception filter and the surface formatter registry (decision 028),
// and registers the Dhru envelope for the Dhru surface (decision 026).
import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MetricsModule } from '../../infra/metrics/metrics.module';
import { DhruErrorFormatter } from './dhru-formatter';
import { ProblemExceptionFilter } from './exception.filter';
import { ErrorFormatterRegistry } from './formatter-registry';

/**
 * Registers {@link ProblemExceptionFilter} for the whole application and exports the formatter registry.
 *
 * Why: one filter for every route is the guarantee of decision 028; surfaces with their own envelope (Dhru,
 * decision 026) register a formatter in the registry instead of replacing the filter. The Dhru error envelope is
 * registered here because the security guards already answer on that surface (`Authentication Failed`).
 */
@Global()
@Module({
  imports: [MetricsModule],
  providers: [
    ErrorFormatterRegistry,
    ProblemExceptionFilter,
    { provide: APP_FILTER, useExisting: ProblemExceptionFilter },
  ],
  exports: [ErrorFormatterRegistry, ProblemExceptionFilter],
})
export class ErrorsModule implements OnModuleInit {
  constructor(private readonly formatters: ErrorFormatterRegistry) {}

  /** Registers the Dhru error envelope; the registry refuses a second formatter with the same name. */
  onModuleInit(): void {
    this.formatters.register(new DhruErrorFormatter());
  }
}
