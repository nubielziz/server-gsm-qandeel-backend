// Unit tests of the reply channels (RULES support 6, ANSWERS support Q2).
import { describe, expect, it } from 'bun:test';
import { pickReplyChannel, replyChannelsOf } from './reply-channels';

describe('replyChannelsOf', () => {
  it('is email for a customer, and email plus telegram for a merchant with a linked chat', () => {
    expect(replyChannelsOf({ requesterType: 'customer', reachable: true, telegramChatId: null })).toEqual(['email']);
    expect(replyChannelsOf({ requesterType: 'client', reachable: true, telegramChatId: null })).toEqual(['email']);
    expect(replyChannelsOf({ requesterType: 'client', reachable: true, telegramChatId: '555' })).toEqual([
      'email',
      'telegram',
    ]);
  });

  it('never offers telegram to a customer, and nothing to a requester that cannot be reached', () => {
    expect(replyChannelsOf({ requesterType: 'customer', reachable: true, telegramChatId: '555' })).toEqual(['email']);
    expect(replyChannelsOf({ requesterType: 'client', reachable: false, telegramChatId: '555' })).toEqual([]);
  });
});

describe('pickReplyChannel', () => {
  it('takes the named channel when the ticket allows it and refuses it otherwise', () => {
    expect(pickReplyChannel('telegram', 'email', ['email', 'telegram'])).toBe('telegram');
    expect(pickReplyChannel('telegram', 'email', ['email'])).toBeUndefined();
    expect(pickReplyChannel('email', 'web', [])).toBeUndefined();
  });

  it('uses the ticket’s own channel when allowed, else email', () => {
    expect(pickReplyChannel(undefined, 'telegram', ['email', 'telegram'])).toBe('telegram');
    expect(pickReplyChannel(undefined, 'telegram', ['email'])).toBe('email');
    expect(pickReplyChannel(undefined, 'web', ['email', 'telegram'])).toBe('email');
    expect(pickReplyChannel(undefined, 'chat', [])).toBeUndefined();
  });
});
