// Global Nest module of the request pipeline registry (decision 018). Import it in the API's root module only: the worker has
// no HTTP pipeline.
import { Global, Module } from '@nestjs/common';
import { RequestPipeline } from './request-pipeline';

/**
 * Provides {@link RequestPipeline} to every module.
 *
 * Why: the IP rules (identity), maintenance (platform) and the per-IP limiter (rate-limit infrastructure) each register
 * their stage with the same registry. It needs the global error filter from `ErrorsModule`.
 */
@Global()
@Module({ providers: [RequestPipeline], exports: [RequestPipeline] })
export class PipelineModule {}
