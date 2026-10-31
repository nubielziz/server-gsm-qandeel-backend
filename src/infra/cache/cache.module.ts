// Global Nest module for the cache (decision 022): CacheService and the CacheKeys builders. Shared by the API and the worker.
import { Global, Module } from '@nestjs/common';
import { CacheKeys } from './cache-keys';
import { CacheService } from './cache.service';

/**
 * Provides {@link CacheService} and {@link CacheKeys} to every module.
 *
 * Why: hot reads in many modules go through one cache-aside service with one key scheme (decision 022). It needs the
 * global Redis and metrics modules, which are imported by both root modules.
 */
@Global()
@Module({ providers: [CacheKeys, CacheService], exports: [CacheKeys, CacheService] })
export class CacheModule {}
