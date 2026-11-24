// Unit tests of the campaign views (feature 23): a campaign stored before a channel was retired reads without that channel.
import { describe, expect, it } from 'bun:test';
import type { NotificationCampaign } from '@src/modules/platform/db/schema';
import { channelsOf } from '@src/modules/platform/notifications/campaigns/campaign-views';

const row = (channels: string[]) => ({ channels }) as unknown as NotificationCampaign;

describe('channelsOf', () => {
  it('lists the channels of a campaign in the stored order', () => {
    expect(channelsOf(row(['in_app', 'email']))).toEqual(['in_app', 'email']);
    expect(channelsOf(row(['email']))).toEqual(['email']);
  });

  it('leaves out the retired Telegram channel that the column still allows, so nothing is planned, counted or sent for it', () => {
    expect(channelsOf(row(['in_app', 'email', 'telegram']))).toEqual(['in_app', 'email']);
    expect(channelsOf(row(['telegram']))).toEqual([]);
  });
});
