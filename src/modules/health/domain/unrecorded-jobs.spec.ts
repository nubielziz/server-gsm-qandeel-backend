// Unit tests of the list of scheduled jobs that write no job_runs row.
import { describe, expect, it } from 'bun:test';
import { UNRECORDED_JOBS, isRecordedJob } from './unrecorded-jobs';

describe('isRecordedJob', () => {
  it('is false for the three housekeeping jobs and true for every job that writes job_runs', () => {
    expect([...UNRECORDED_JOBS].sort()).toEqual(['ip_rule_hits_flush', 'supplier_poll_tick', 'tick']);
    for (const name of UNRECORDED_JOBS) expect(isRecordedJob(name)).toBe(false);
    for (const name of [
      'service_checks',
      'service_checks_purge',
      'job_runs_reaper',
      'db_size_sample',
      'session_purge',
      'client_group_promotion',
      'price_sync',
      'balance_check',
    ])
      expect(isRecordedJob(name)).toBe(true);
  });
});
