// Unit tests of the audience-provider registry and the shared SQL helpers (feature 23, plan section 5.2): one provider per group of people
// (staff, merchant ranks, retail), a clear error for a missing one, the "reachable" condition per channel set and the send-time query.
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  type AudienceProvider,
  NO_COUNTS,
  NotificationAudiences,
  audienceCountFields,
  memberQuery,
  reachableSql,
} from '@src/modules/platform/notifications/campaigns/notification-audiences';

const provider = (kind: AudienceProvider['kind']): AudienceProvider => ({
  kind,
  count: () => Promise.resolve(NO_COUNTS),
  page: () => Promise.resolve([]),
  member: () => Promise.resolve(undefined),
});

const dialect = new PgDialect();
const text = (query: ReturnType<typeof reachableSql>) => dialect.sqlToQuery(query).sql;
const FLAGS = { inApp: sql`IN_APP`, email: sql`EMAIL` };

describe('NotificationAudiences', () => {
  it('registers one provider per group and finds it', () => {
    const audiences = new NotificationAudiences();
    const staff = provider('staff');
    audiences.register(staff);
    audiences.register(provider('retail'));
    expect(audiences.get('staff')).toBe(staff);
    expect(audiences.has('merchant')).toBe(false);
    expect(audiences.kinds()).toEqual(['staff', 'retail']);
  });

  it('refuses a second provider of one group (a boot-time mistake)', () => {
    const audiences = new NotificationAudiences();
    audiences.register(provider('merchant'));
    expect(() => audiences.register(provider('merchant'))).toThrow('already registered');
  });

  it('holds the two account groups apart: merchant ranks and retail are two providers of one table', () => {
    const audiences = new NotificationAudiences();
    const merchants = provider('merchant');
    const retail = provider('retail');
    audiences.register(merchants);
    audiences.register(retail);
    expect(audiences.get('merchant')).toBe(merchants);
    expect(audiences.get('retail')).toBe(retail);
  });

  it('names the group when no provider is registered', () => {
    expect(() => new NotificationAudiences().get('retail')).toThrow('"retail"');
  });
});

describe('reachableSql', () => {
  it('is true when any chosen channel reaches the person', () => {
    expect(text(reachableSql(FLAGS, ['in_app', 'email']))).toBe('((IN_APP) or (EMAIL))');
    expect(text(reachableSql(FLAGS, ['email']))).toBe('((EMAIL))');
    // A channel the code no longer knows (an older campaign may list one) counts nobody.
    expect(text(reachableSql(FLAGS, ['telegram' as never]))).toBe('false');
  });

  it('is false without a channel', () => {
    expect(text(reachableSql(FLAGS, []))).toBe('false');
  });
});

describe('audienceCountFields', () => {
  it('counts the total, the reachable people and each channel', () => {
    const fields = audienceCountFields(FLAGS, ['email']);
    expect(Object.keys(fields).sort()).toEqual(['email', 'inApp', 'reachable', 'total']);
    expect(text(fields.reachable)).toContain('((EMAIL))');
  });
});

describe('memberQuery', () => {
  it('asks for one id with no segment and every channel (the send-time check)', () => {
    expect(memberQuery('marketing', 7)).toEqual({
      segment: undefined,
      include: [7],
      exclude: [],
      purpose: 'marketing',
      channels: ['in_app', 'email'],
    });
  });
});
