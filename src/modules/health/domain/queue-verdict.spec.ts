// Unit tests of the queue and job verdicts and of the failed-job subject.
import { describe, expect, it } from 'bun:test';
import { jobState, jobSubject, queueState } from './queue-verdict';

const calm = { oldestAgeSeconds: 0, failed: 0, paused: false, workers: 2 };

describe('queueState', () => {
  it('is ok for a calm queue and the worst of its parts otherwise', () => {
    expect(queueState(calm)).toBe('ok');
    expect(queueState({ ...calm, oldestAgeSeconds: 121 })).toBe('warn');
    expect(queueState({ ...calm, oldestAgeSeconds: 601 })).toBe('crit');
    expect(queueState({ ...calm, failed: 9 })).toBe('ok');
    expect(queueState({ ...calm, failed: 10 })).toBe('warn');
    expect(queueState({ ...calm, failed: 50 })).toBe('crit');
    expect(queueState({ ...calm, paused: true })).toBe('warn');
    expect(queueState({ ...calm, workers: 0 })).toBe('crit');
    expect(queueState({ ...calm, paused: true, failed: 50 })).toBe('crit');
  });
});

describe('jobState', () => {
  it('maps the last finished run', () => {
    expect(jobState('failed')).toBe('crit');
    expect(jobState('skipped')).toBe('warn');
    expect(jobState('succeeded')).toBe('ok');
    expect(jobState(null)).toBe('unknown');
  });
});

describe('jobSubject', () => {
  it('reads the subject from the ids a payload carries and never from anything else', () => {
    expect(jobSubject({ aggregateType: 'order', aggregateId: 10422 })).toBe('order #10422');
    expect(jobSubject({ orderId: 7, requestId: 'abc' })).toBe('order #7');
    expect(jobSubject({ supplierServiceId: 3 })).toBe('supplier service #3');
    expect(jobSubject({ requestId: 'abc', note: 'x' })).toBeNull();
    expect(jobSubject(null)).toBeNull();
    expect(jobSubject('text')).toBeNull();
  });
});
