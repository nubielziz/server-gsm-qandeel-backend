// Nest module of the IP rule hit counters (identity module), recording side: the API's hook counts. The worker flushes through
// IpRuleHitsFlushModule.
import { Module } from '@nestjs/common';
import { IpRuleHits } from './ip-rule-hits';

/**
 * Provides {@link IpRuleHits}.
 *
 * Why: the IP rules hook counts the requests a rule decided. It needs the global Redis, cache-key and metrics modules.
 */
@Module({ providers: [IpRuleHits], exports: [IpRuleHits] })
export class IpRuleHitsModule {}
