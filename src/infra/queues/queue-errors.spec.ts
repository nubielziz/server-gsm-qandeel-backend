// Unit tests of isQueueUnavailableError (decision 006): connection trouble is told apart from a mistake in the call.
import { describe, expect, it } from 'bun:test';
import { isQueueUnavailableError } from './queue-errors';

describe('isQueueUnavailableError', () => {
  it('is true for what ioredis and the socket report while Redis is away', () => {
    for (const message of [
      "Stream isn't writeable and enableOfflineQueue options is false",
      'Connection is closed.',
      'Command timed out',
      'connect ECONNREFUSED 127.0.0.1:6379',
      'read ECONNRESET',
      'connect ETIMEDOUT 10.0.0.5:6379',
      'getaddrinfo ENOTFOUND redis.internal',
      'getaddrinfo EAI_AGAIN redis.internal',
      'write EPIPE',
      'Reached the max retries per request limit (which is 1). Refer to "maxRetriesPerRequest" option for details.',
    ]) {
      expect(isQueueUnavailableError(new Error(message)), message).toBe(true);
    }
    const maxRetries = new Error('anything');
    maxRetries.name = 'MaxRetriesPerRequestError';
    expect(isQueueUnavailableError(maxRetries)).toBe(true);
  });

  it('is true for a Redis that is up but cannot take writes: a full noeviction instance, loading, a replica', () => {
    for (const message of [
      "OOM command not allowed when used memory > 'maxmemory'.",
      'LOADING Redis is loading the dataset in memory',
      "READONLY You can't write against a read only replica.",
      'MISCONF Redis is configured to save RDB snapshots, but it is currently not able to persist on disk.',
      'BUSY Redis is busy running a script.',
    ]) {
      expect(isQueueUnavailableError(new Error(message)), message).toBe(true);
    }
  });

  it('finds the cause behind a wrapper', () => {
    const wrapped = new Error('Job could not be added', { cause: new Error('connect ECONNREFUSED 127.0.0.1:6379') });
    expect(isQueueUnavailableError(wrapped)).toBe(true);
  });

  it('is false for a mistake in the call, so a bug is never hidden as an outage', () => {
    for (const message of [
      'Custom Id cannot contain :',
      'Custom Id cannot be integers',
      'The size of job x exceeds the limit 100 bytes',
      'Priority should be between 0 and 2097152',
      'ERR syntax error',
    ]) {
      expect(isQueueUnavailableError(new Error(message)), message).toBe(false);
    }
    expect(isQueueUnavailableError('connect ECONNREFUSED')).toBe(false);
    expect(isQueueUnavailableError(undefined)).toBe(false);
  });
});
