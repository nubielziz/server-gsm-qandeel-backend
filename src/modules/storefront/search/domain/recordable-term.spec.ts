import { describe, expect, it } from 'bun:test';
import { isBotUserAgent, isPrefetchRequest, isRecordableTerm } from './recordable-term';

describe('isRecordableTerm', () => {
  it('counts ordinary words and model codes', () => {
    for (const term of [
      'samsung frp',
      'icloud',
      'a525f',
      'sm-a525f',
      'iphone 15 pro max',
      'at&t unlock'.replace('&', ''),
    ]) {
      expect(isRecordableTerm(term)).toBe(true);
    }
  });

  it('never counts an IMEI, a phone number, an email, an order number or a link', () => {
    for (const term of [
      '356938035643809',
      '3569 3803 5643 809',
      '+962791234567',
      '0791234567',
      'me@example.com',
      '@name',
      'ord-2026-000123',
      'https://example.com/x',
      'www.example.com',
      'visit http://x.y',
    ]) {
      expect(isRecordableTerm(term)).toBe(false);
    }
  });

  it('keeps to 2-64 characters and 5 digits in all', () => {
    expect(isRecordableTerm('a')).toBe(false);
    expect(isRecordableTerm('ab')).toBe(true);
    expect(isRecordableTerm('a'.repeat(64))).toBe(true);
    expect(isRecordableTerm('a'.repeat(65))).toBe(false);
    expect(isRecordableTerm('a1 b2 c3 d4 e5')).toBe(true);
    expect(isRecordableTerm('a1 b2 c3 d4 e5 f6')).toBe(false);
  });
});

describe('isBotUserAgent', () => {
  it('knows crawlers, monitors, previews and headless browsers', () => {
    for (const agent of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0)',
      'Mozilla/5.0 (Windows NT 10.0) HeadlessChrome/120.0',
      'Slackbot-LinkExpanding 1.0',
      'curl/8.4.0',
      'Mozilla/5.0 (compatible; Yahoo! Slurp)',
      'WhatsApp link preview',
      'Pingdom.com_bot_version_1.4',
      'python-requests/2.31',
    ]) {
      expect(isBotUserAgent(agent)).toBe(true);
    }
    expect(isBotUserAgent(undefined)).toBe(true);
    expect(isBotUserAgent('  ')).toBe(true);
  });

  it('lets browsers through', () => {
    for (const agent of [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
    ]) {
      expect(isBotUserAgent(agent)).toBe(false);
    }
  });
});

describe('isPrefetchRequest', () => {
  it('knows the three prefetch signals', () => {
    expect(isPrefetchRequest({ 'next-router-prefetch': '1' })).toBe(true);
    expect(isPrefetchRequest({ purpose: 'prefetch' })).toBe(true);
    expect(isPrefetchRequest({ 'sec-purpose': 'prefetch;anonymous-client-ip' })).toBe(true);
  });

  it('lets an ordinary request through', () => {
    expect(isPrefetchRequest({})).toBe(false);
    expect(isPrefetchRequest({ purpose: 'navigate', 'sec-purpose': undefined })).toBe(false);
  });
});
