// Nest module of the IP rules stage (identity module): the cached rule set, the hit counters and the pipeline hook.
// API process only; the worker flushes the counters through IpRuleHitsFlushModule.
import { Module } from '@nestjs/common';
import { IpRuleCache } from './ip-rule-cache';
import { IpRuleHitsModule } from './ip-rule-hits.module';
import { IpRulesHook } from './ip-rules.hook';

/**
 * Provides {@link IpRuleCache} and registers the IP rules stage with the request pipeline.
 *
 * Why: scenario ip-rules judges every request before authentication. The module needs the global pipeline, settings,
 * cache and database modules, which the API's root module imports. It exports the cache so the IP rule routes (feature 2a)
 * can invalidate it after their commit.
 */
@Module({
  imports: [IpRuleHitsModule],
  providers: [IpRuleCache, IpRulesHook],
  exports: [IpRuleCache, IpRuleHitsModule],
})
export class IpRulesModule {}
