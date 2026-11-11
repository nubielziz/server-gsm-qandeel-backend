// Unit tests of the audience-provider registry and the shared SQL helpers (feature 23, plan section 5.2): one provider per type, a
// clear error for a missing one, the "reachable" condition per channel set and the send-time query.
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
} from './notification-audiences';

const provider = (type: AudienceProvider['type']): AudienceProvider => ({
  type,
  count: () => Promise.resolve(NO_COUNTS),
  page: () => Promise.resolve([]),
  member: () => Promise.resolve(undefined),
});

const dialect = new PgDialect();
const text = (query: ReturnType<typeof reachableSql>) => dialect.sqlToQuery(query).sql;
const FLAGS = { inApp: sql`IN_APP`, email: sql`EMAIL`, telegram: sql`TELEGRAM`, arabic: sql`ARABIC` };

describe('NotificationAudiences', () => {
  it('registers one provider per type and finds it', () => {
    const audiences = new NotificationAudiences();
    const staff = provider('staff');
    audiences.register(staff);
    audiences.register(provider('customer'));
    expect(audiences.get('staff')).toBe(staff);
    expect(audiences.has('client')).toBe(false);
    expect(audiences.types()).toEqual(['staff', 'customer']);
  });

  it('refuses a second provider of one type (a boot-time mistake)', () => {
    const audiences = new NotificationAudiences();
    audiences.register(provider('client'));
    expect(() => audiences.register(provider('client'))).toThrow('already registered');
  });

  it('names the type when no provider is registered', () => {
    expect(() => new NotificationAudiences().get('customer')).toThrow('"customer"');
  });
});

describe('reachableSql', () => {
  it('is true when any chosen channel reaches the person', () => {
    expect(text(reachableSql(FLAGS, ['in_app', 'email']))).toBe('((IN_APP) or (EMAIL))');
    expect(text(reachableSql(FLAGS, ['telegram']))).toBe('((TELEGRAM))');
  });

  it('is false without a channel', () => {
    expect(text(reachableSql(FLAGS, []))).toBe('false');
  });
});

describe('audienceCountFields', () => {
  it('counts the total, the reachable people, each channel and the reachable people by language', () => {
    const fields = audienceCountFields(FLAGS, ['email']);
    expect(Object.keys(fields).sort()).toEqual(['ar', 'email', 'en', 'inApp', 'reachable', 'telegram', 'total']);
    expect(text(fields.ar)).toContain('((EMAIL)) and (ARABIC)');
    expect(text(fields.en)).toContain('((EMAIL)) and not (ARABIC)');
  });
});

describe('memberQuery', () => {
  it('asks for one id with no segment and every channel (the send-time check)', () => {
    expect(memberQuery('marketing', 7)).toEqual({
      segment: undefined,
      include: [7],
      exclude: [],
      purpose: 'marketing',
      channels: ['in_app', 'email', 'telegram'],
    });
  });
});
