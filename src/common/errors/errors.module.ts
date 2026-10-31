// Global module that installs the problem+json exception filter and the surface formatter registry (decision 028).
import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MetricsModule } from '../../infra/metrics/metrics.module';
import { ProblemExceptionFilter } from './exception.filter';
import { ErrorFormatterRegistry } from './formatter-registry';

/**
 * Registers {@link ProblemExceptionFilter} for the whole application and exports the formatter registry.
 *
 * Why: one filter for every route is the guarantee of decision 028; surfaces with their own envelope (Dhru,
 * decision 026) register a formatter in the registry instead of replacing the filter.
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
export class ErrorsModule {}
