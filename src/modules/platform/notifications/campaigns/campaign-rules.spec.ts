// Unit tests of the campaign rules (feature 23, plan section 6): status lists, content, links, schedule bounds, the confirm tolerance,
// the inbox category, which rows a member gets and the stats arithmetic.
import { describe, expect, it } from 'bun:test';
import {
  CANCELLABLE_STATUSES,
  EDITABLE_STATUSES,
  EMPTY_STATS,
  FANOUT_STATUSES,
  MAX_SCHEDULE_AHEAD_MS,
  MIN_SCHEDULE_AHEAD_MS,
  SENDABLE_STATUSES,
  addStats,
  campaignDedupeKey,
  categoryOf,
  confirmProblem,
  contentProblems,
  linkProblems,
  rowsFor,
  scheduleProblem,
  statsOf,
} from './campaign-rules';

const fields = (errors: Array<{ field: string }>) => errors.map((error) => error.field);

describe('status lists', () => {
  it('edits and sends drafts and scheduled campaigns, cancels scheduled and running ones, fans out queued and sending ones', () => {
    expect(EDITABLE_STATUSES).toEqual(['draft', 'scheduled']);
    expect(SENDABLE_STATUSES).toEqual(['draft', 'scheduled']);
    expect(CANCELLABLE_STATUSES).toEqual(['scheduled', 'queued', 'sending']);
    expect(FANOUT_STATUSES).toEqual(['queued', 'sending']);
  });
});

describe('contentProblems', () => {
  const content = { title: 'Hello {{name}}', body: 'Maintenance on Friday.\nThanks.' };

  it('accepts plain text with {{name}}', () => {
    expect(contentProblems(content)).toEqual([]);
    expect(contentProblems({ title: 'Hello {{ name }}', body: 'Thanks.' })).toEqual([]);
  });

  it('refuses blank text, other placeholders and HTML, naming the field', () => {
    expect(fields(contentProblems({ title: '  ', body: 'x' }))).toEqual(['content.title']);
    expect(contentProblems({ title: 'Hi {{orderId}}', body: 'x' })[0]).toMatchObject({
      field: 'content.title',
      code: 'unknown_placeholder',
    });
    expect(contentProblems({ title: 'Hi', body: '<p>Hello</p>' })[0]).toMatchObject({
      field: 'content.body',
      code: 'html',
      message: 'Write plain text; the email layout is added for you.',
    });
    expect(fields(contentProblems({ title: 'x', body: '<script>alert(1)</script><br>' }))).toEqual(['content.body']);
  });

  it('refuses any tag, not only the layout tags templates look for, but keeps plain comparisons', () => {
    for (const body of [
      '<b>Hi</b>',
      '<script src="x"></script>',
      '<br/>',
      '<img src=x onerror=alert(1)>',
      '<custom-tag>',
    ]) {
      expect(fields(contentProblems({ title: 'Hi', body })), body).toEqual(['content.body']);
    }
    for (const body of ['a < b and c > d', 'I <3 unlocks', 'Prices from 5<10', 'Use -> and <-']) {
      expect(contentProblems({ title: 'Hi', body }), body).toEqual([]);
    }
  });
});

describe('linkProblems', () => {
  it('accepts site paths per audience', () => {
    expect(linkProblems(null)).toEqual([]);
    expect(
      linkProblems({ customer: '/account/orders', merchant: '/merchant/wallet?tab=top-up#x', staff: '/' }),
    ).toEqual([]);
  });

  it('refuses anything that could leave the site', () => {
    for (const bad of ['https://evil.example', '//evil.example', 'account', '/a b', 'javascript:alert(1)', '/\\evil']) {
      expect(fields(linkProblems({ customer: bad })), bad).toEqual(['link.customer']);
    }
    expect(fields(linkProblems({ merchant: `/${'a'.repeat(200)}` }))).toEqual(['link.merchant']);
  });

  it('keeps a merchant link inside the merchant portal: the inbox and the email both use the site path', () => {
    for (const good of ['/merchant', '/merchant/orders', '/merchant?tab=x', '/merchant#top']) {
      expect(linkProblems({ merchant: good }), good).toEqual([]);
    }
    for (const bad of ['/orders', '/merchants/x', '/account/orders', '/']) {
      expect(linkProblems({ merchant: bad }), bad).toEqual([
        {
          field: 'link.merchant',
          code: 'invalid',
          message: 'Use a page of the merchant portal, such as /merchant/orders.',
        },
      ]);
    }
  });
});

describe('scheduleProblem', () => {
  const now = Date.parse('2026-11-10T10:00:00.000Z');

  it('accepts one minute to 90 days ahead, both bounds included', () => {
    expect(scheduleProblem(new Date(now + MIN_SCHEDULE_AHEAD_MS), now)).toBeUndefined();
    expect(scheduleProblem(new Date(now + MAX_SCHEDULE_AHEAD_MS), now)).toBeUndefined();
  });

  it('refuses earlier and later times on scheduledAt', () => {
    expect(scheduleProblem(new Date(now + MIN_SCHEDULE_AHEAD_MS - 1), now)).toMatchObject({
      field: 'scheduledAt',
      code: 'too_soon',
    });
    expect(scheduleProblem(new Date(now - 1), now)?.code).toBe('too_soon');
    expect(scheduleProblem(new Date(now + MAX_SCHEDULE_AHEAD_MS + 1), now)).toMatchObject({
      field: 'scheduledAt',
      code: 'too_late',
    });
  });
});

describe('confirmProblem', () => {
  it('refuses an empty audience', () => {
    expect(confirmProblem(10, 0)).toBe('empty');
  });

  it('tolerates a drift of max(5, 2 %)', () => {
    expect(confirmProblem(100, 105)).toBeUndefined();
    expect(confirmProblem(100, 106)).toBe('changed');
    expect(confirmProblem(100, 95)).toBeUndefined();
    expect(confirmProblem(100, 94)).toBe('changed');
    expect(confirmProblem(1000, 1020)).toBeUndefined();
    expect(confirmProblem(1000, 1021)).toBe('changed');
    expect(confirmProblem(1, 6)).toBeUndefined();
  });
});

describe('categoryOf', () => {
  it('files service campaigns as announcements and marketing as marketing', () => {
    expect(categoryOf('service')).toBe('announcement');
    expect(categoryOf('marketing')).toBe('marketing');
  });
});

describe('rowsFor', () => {
  it('makes a row per chosen channel that reaches the member, and names the skip of each other chosen channel', () => {
    for (const inApp of [true, false]) {
      for (const email of [true, false]) {
        for (const telegram of [true, false]) {
          const member = { id: 1, inApp, email, telegram };
          const all = rowsFor(member, ['in_app', 'email', 'telegram']);
          expect(all).toEqual({
            inApp,
            email,
            telegram,
            skipped: { noAccount: !inApp, optedOut: !email, noTelegram: !telegram },
          });
          const none = rowsFor(member, []);
          expect(none).toEqual({
            inApp: false,
            email: false,
            telegram: false,
            skipped: { noAccount: false, optedOut: false, noTelegram: false },
          });
          const emailOnly = rowsFor(member, ['email']);
          expect(emailOnly.inApp || emailOnly.telegram).toBe(false);
          expect(emailOnly.skipped).toEqual({ noAccount: false, optedOut: !email, noTelegram: false });
        }
      }
    }
  });
});

describe('stats', () => {
  it('reads partial stored stats as zeros and adds stats', () => {
    expect(statsOf({})).toEqual(EMPTY_STATS);
    expect(statsOf({ planned: { inApp: 2, email: 'x' } })).toEqual({
      planned: { inApp: 2, email: 0, telegram: 0 },
      skipped: { optedOut: 0, noTelegram: 0, noAccount: 0 },
    });
    const one = { planned: { inApp: 1, email: 2, telegram: 3 }, skipped: { optedOut: 4, noTelegram: 5, noAccount: 6 } };
    expect(addStats(one, one)).toEqual({
      planned: { inApp: 2, email: 4, telegram: 6 },
      skipped: { optedOut: 8, noTelegram: 10, noAccount: 12 },
    });
  });

  it('keys a campaign row by campaign, channel and person', () => {
    expect(campaignDedupeKey(7, 'email', 'client', 42)).toBe('campaign-7:email:client-42');
  });
});
