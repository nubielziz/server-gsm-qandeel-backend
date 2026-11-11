// The worker processor of `notification.campaign_fanout` on the `notifications` queue (feature 23, plan section 8.1): the relay's job of
// a sent campaign, a continuation, or a re-kick by the sweep.
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor, UnrecoverableError } from '../../../../infra/queues';
import type { OutboxJobData } from '../../outbox/outbox.types';
import { type FanOutJobData, type FanOutResult, CampaignFanOut } from './campaign-fan-out';
import { CAMPAIGN_FANOUT_EVENT } from './campaign-rules';

/**
 * Runs a campaign's fan-out.
 *
 * Why: `send` and the sweep write the outbox event `notification.campaign_fanout` (aggregate: the campaign); the relay turns it into
 * this job (`outbox-<event id>`). Continuations (`campaign-fanout-<id>-<chunks>`) and re-kicks (`campaign-fanout-<id>-r<minute>`)
 * carry `campaignId`. The fan-out is idempotent, so any number of these jobs for one campaign is harmless.
 */
@Injectable()
@QueueProcessor('notifications', CAMPAIGN_FANOUT_EVENT)
export class CampaignFanOutProcessor implements JobProcessor<
  Partial<OutboxJobData> & Partial<FanOutJobData>,
  FanOutResult
> {
  constructor(private readonly fanOut: CampaignFanOut) {}

  /**
   * Handles one job.
   *
   * @param job the relay's job (`aggregateId`) or a continuation (`campaignId`, `round`)
   * @returns what the run did
   * @throws {UnrecoverableError} when the job names no campaign, or the campaign cannot be fanned out (it is `failed`)
   */
  async process(
    job: Job<Partial<OutboxJobData> & Partial<FanOutJobData>, FanOutResult, string>,
  ): Promise<FanOutResult> {
    const id = typeof job.data.campaignId === 'number' ? job.data.campaignId : job.data.aggregateId;
    if (typeof id !== 'number') throw new UnrecoverableError('A campaign fan-out job names no campaign.');
    return this.fanOut.run(id, typeof job.data.round === 'number' ? job.data.round : 0);
  }
}
