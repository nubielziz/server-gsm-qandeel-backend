// Unit tests of the Dhru wire format that is not specific to one action (decision 026): the envelope, the base64 JSON fields and the status numbers.
import { describe, expect, it } from 'bun:test';
import { AppError } from '../errors';
import {
  DHRU_HEADERS,
  type DhruItemAnswer,
  decodeBase64Object,
  dhruBulk,
  dhruError,
  dhruStatusOf,
  dhruSuccess,
  readCustomFields,
  readParameters,
} from './dhru-envelope';

const base64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

/** The detail a refused read throws. */
function refusal(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('the envelope', () => {
  it('wraps a success entry in SUCCESS with the api version, and an error in ERROR', () => {
    expect(dhruSuccess({ MESSAGE: 'x' })).toEqual({ SUCCESS: [{ MESSAGE: 'x' }], apiversion: '6.1' });
    expect(dhruError('Not enough credits')).toEqual({ ERROR: [{ MESSAGE: 'Not enough credits' }] });
  });

  it('puts the answers of a bulk call under the caller request ids, then apiversion last', () => {
    const body = dhruBulk(
      new Map<string, DhruItemAnswer>([
        ['a', { SUCCESS: [{ MESSAGE: 'ok' }] }],
        ['b', dhruError('no')],
      ]),
    );
    expect(Object.keys(body)).toEqual(['a', 'b', 'apiversion']);
    expect(body).toEqual({ a: { SUCCESS: [{ MESSAGE: 'ok' }] }, b: { ERROR: [{ MESSAGE: 'no' }] }, apiversion: '6.1' });
  });

  it('names the two headers client software looks for', () => {
    expect(DHRU_HEADERS).toEqual({ 'x-powered-by': 'DHRU-FUSION', 'dhru-fusion-api-version': '6.1' });
  });
});

describe('decodeBase64Object', () => {
  it('reads base64 of a JSON object, with padding or without, URL-safe or not', () => {
    expect(decodeBase64Object(base64({ ID: 5 }))).toEqual({ ID: 5 });
    expect(decodeBase64Object(base64({ ID: 5 }).replace(/=+$/, ''))).toEqual({ ID: 5 });
    const tricky = base64({ a: '?>>' });
    expect(tricky).toContain('+');
    expect(decodeBase64Object(tricky.replace(/\+/g, ' '))).toEqual({ a: '?>>' });
    expect(decodeBase64Object(tricky.replace(/\+/g, '-').replace(/\//g, '_'))).toEqual({ a: '?>>' });
    expect(decodeBase64Object(`  ${base64({ ID: 5 })}\n`)).toEqual({ ID: 5 });
  });

  it('answers "Invalid parameters" for anything that is not base64 of an object', () => {
    for (const bad of [
      '',
      '%%%',
      'not base64!',
      base64([1, 2]),
      base64('text'),
      base64(null),
      Buffer.from('{bad').toString('base64'),
    ]) {
      const error = refusal(() => decodeBase64Object(bad));
      expect(error.code, bad).toBe('VALIDATION_FAILED');
      expect(error.detail, bad).toBe('Invalid parameters');
    }
  });
});

describe('readParameters', () => {
  it('reads the base64 text of the standard, an object, and nothing', () => {
    expect(readParameters(base64({ ID: 1 }))).toEqual({ ID: 1 });
    expect(readParameters({ ID: 1 })).toEqual({ ID: 1 });
    for (const none of [undefined, null, '']) expect(readParameters(none)).toEqual({});
  });

  it('refuses a list, a number and a bad text', () => {
    for (const bad of [[1], 5, true, '%%%'])
      expect(refusal(() => readParameters(bad)).detail).toBe('Invalid parameters');
  });
});

describe('readCustomFields', () => {
  it('reads base64 JSON or an object, turns numbers and booleans into text and leaves out null and empty values', () => {
    expect(readCustomFields(base64({ username: 'ahmad', pin: 1234, vip: true, empty: '', none: null }))).toEqual({
      username: 'ahmad',
      pin: '1234',
      vip: 'true',
    });
    expect(readCustomFields({ a: 'b' })).toEqual({ a: 'b' });
    for (const none of [undefined, null, '']) expect(readCustomFields(none)).toEqual({});
  });

  it('refuses a nested value, a list and text that is not base64 JSON', () => {
    expect(refusal(() => readCustomFields({ a: { b: 1 } })).detail).toBe('Invalid custom field a');
    expect(refusal(() => readCustomFields([1])).detail).toBe('Invalid custom fields');
    expect(refusal(() => readCustomFields('%%%')).detail).toBe('Invalid parameters');
  });
});

describe('dhruStatusOf', () => {
  it('maps the order statuses to the numbers of decision 025 and 026', () => {
    expect(dhruStatusOf('pending')).toBe(0);
    expect(dhruStatusOf('processing')).toBe(1);
    expect(dhruStatusOf('rejected')).toBe(3);
    expect(dhruStatusOf('completed')).toBe(4);
  });
});
