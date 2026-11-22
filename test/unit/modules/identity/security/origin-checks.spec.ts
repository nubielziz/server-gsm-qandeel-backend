// Unit tests for the Origin rules of the CSRF guard (decisions 018 and 045).
import { describe, expect, it } from 'bun:test';
import {
  NOT_STARTED_HERE_DETAIL,
  ORIGIN_MISSING_DETAIL,
  ORIGIN_NOT_ALLOWED_DETAIL,
  originCheckedGetRefusal,
  sessionlessOriginRefusal,
  startedByAnotherSite,
} from '@src/modules/identity/security/origin-checks';

const ALLOWED = ['https://console.example.com'];
const OTHER_AUDIENCE = ['https://shop.example.com'];

describe('sessionlessOriginRefusal', () => {
  it('needs one of the allowed origins for a mutation without a session', () => {
    expect(sessionlessOriginRefusal('https://console.example.com', ALLOWED)).toBeUndefined();
    expect(sessionlessOriginRefusal(undefined, ALLOWED)).toBe(ORIGIN_MISSING_DETAIL);
    for (const origin of ['https://evil.example', 'null', '', 'https://console.example.com/']) {
      expect(sessionlessOriginRefusal(origin, ALLOWED), origin).toBe(ORIGIN_NOT_ALLOWED_DETAIL);
    }
    // An origin that the other audience lists is not one of this audience's.
    expect(sessionlessOriginRefusal('https://shop.example.com', ALLOWED)).toBe(ORIGIN_NOT_ALLOWED_DETAIL);
    expect(sessionlessOriginRefusal('https://shop.example.com', OTHER_AUDIENCE)).toBeUndefined();
    expect(sessionlessOriginRefusal('https://console.example.com', [])).toBe(ORIGIN_NOT_ALLOWED_DETAIL);
  });
});

describe('originCheckedGetRefusal', () => {
  const listed = 'https://console.example.com';
  const refusal = (headers: { origin?: string; 'sec-fetch-site'?: string | string[] }) =>
    originCheckedGetRefusal(headers, ALLOWED);

  it('answers a request that Sec-Fetch-Site marks as same-origin, with or without an Origin', () => {
    expect(refusal({ 'sec-fetch-site': 'same-origin' })).toBeUndefined();
    expect(refusal({ 'sec-fetch-site': 'same-origin', origin: 'https://evil.example' })).toBeUndefined();
  });

  it('needs an allowed Origin when the request is not same-origin', () => {
    expect(refusal({ 'sec-fetch-site': 'same-site' })).toBe(NOT_STARTED_HERE_DETAIL);
    expect(refusal({ 'sec-fetch-site': 'same-site', origin: listed })).toBeUndefined();
    expect(refusal({ 'sec-fetch-site': 'same-site', origin: 'https://shop.example.com' })).toBe(
      ORIGIN_NOT_ALLOWED_DETAIL,
    );
    expect(refusal({ 'sec-fetch-site': 'cross-site', origin: listed })).toBeUndefined();
    expect(refusal({ 'sec-fetch-site': 'cross-site' })).toBe(NOT_STARTED_HERE_DETAIL);
    expect(refusal({ 'sec-fetch-site': 'none' })).toBe(NOT_STARTED_HERE_DETAIL);
    expect(refusal({})).toBe(ORIGIN_MISSING_DETAIL);
    expect(refusal({ origin: listed })).toBeUndefined();
    expect(refusal({ origin: '' })).toBe(ORIGIN_NOT_ALLOWED_DETAIL);
  });

  it('does not take a repeated Sec-Fetch-Site header for same-origin', () => {
    expect(refusal({ 'sec-fetch-site': ['same-origin', 'same-origin'] })).toBe(NOT_STARTED_HERE_DETAIL);
  });
});

describe('startedByAnotherSite', () => {
  const listed = 'https://console.example.com';
  const judged = (headers: { origin?: string; 'sec-fetch-site'?: string | string[] }) =>
    startedByAnotherSite(headers, ALLOWED);

  it('lets a request through that carries no Sec-Fetch-Site (a call of the portal server), with or without an allowed Origin', () => {
    expect(judged({})).toBe(false);
    expect(judged({ origin: listed })).toBe(false);
  });

  it('lets a request through that the browser marks as the same origin or typed by the user', () => {
    expect(judged({ 'sec-fetch-site': 'same-origin' })).toBe(false);
    expect(judged({ 'sec-fetch-site': 'same-origin', origin: 'https://evil.example' })).toBe(false);
    expect(judged({ 'sec-fetch-site': 'none' })).toBe(false);
  });

  it('refuses a request that the browser marks as cross-site or same-site unless an allowed Origin sent it', () => {
    expect(judged({ 'sec-fetch-site': 'cross-site' })).toBe(true);
    expect(judged({ 'sec-fetch-site': 'same-site' })).toBe(true);
    expect(judged({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })).toBe(true);
    expect(judged({ 'sec-fetch-site': 'cross-site', origin: 'https://shop.example.com' })).toBe(true);
    expect(judged({ 'sec-fetch-site': 'cross-site', origin: '' })).toBe(true);
    expect(judged({ 'sec-fetch-site': 'cross-site', origin: listed })).toBe(false);
    expect(judged({ 'sec-fetch-site': 'same-site', origin: listed })).toBe(false);
  });

  it('judges a repeated or unknown Sec-Fetch-Site value as another site', () => {
    expect(judged({ 'sec-fetch-site': ['same-origin', 'same-origin'] })).toBe(true);
    expect(judged({ 'sec-fetch-site': 'sideways' })).toBe(true);
    expect(judged({ 'sec-fetch-site': '' })).toBe(true);
  });
});
