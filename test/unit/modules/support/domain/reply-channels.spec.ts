// Unit tests of the reply channels (RULES support 6, ANSWERS support Q2).
import { describe, expect, it } from 'bun:test';
import { REPLY_CHANNELS, pickReplyChannel, replyChannelsOf } from '@src/modules/support/domain/reply-channels';

describe('replyChannelsOf', () => {
  it('is email for any requester that can be reached', () => {
    expect(REPLY_CHANNELS).toEqual(['email']);
    expect(replyChannelsOf({ reachable: true })).toEqual(['email']);
  });

  it('is nothing for a requester that cannot be reached', () => {
    expect(replyChannelsOf({ reachable: false })).toEqual([]);
  });
});

describe('pickReplyChannel', () => {
  it('takes the named channel when the ticket allows it and refuses it otherwise', () => {
    expect(pickReplyChannel('email', ['email'])).toBe('email');
    expect(pickReplyChannel('email', [])).toBeUndefined();
  });

  it('uses email when no channel is named, and nothing when nothing is allowed', () => {
    expect(pickReplyChannel(undefined, ['email'])).toBe('email');
    expect(pickReplyChannel(undefined, [])).toBeUndefined();
  });
});
