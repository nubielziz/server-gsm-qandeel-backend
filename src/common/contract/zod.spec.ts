// Unit tests for the shared wire schemas: Money, Decimal, IsoDateTime, Id, DateOnly, JsonObject and their JSON Schema.
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { toJsonSchema } from './json-schema';
import { MAX_ID, zDateOnly, zDecimal, zId, zIdParam, zIsoDateTime, zJsonObject, zMoney } from './zod';

const accepts = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

describe('zMoney', () => {
  it('accepts exactly 4 fraction digits', () => {
    for (const ok of ['0.0000', '12.4900', '-3.5000', '99999999999999.9999', '007.0000'])
      expect(accepts(zMoney, ok)).toBe(true);
  });
  it('rejects anything else, numbers included', () => {
    for (const bad of ['12', '12.49', '12.49000', '12,4900', '+1.0000', '1e3', ' 1.0000', '', 12.49, null, undefined])
      expect(accepts(zMoney, bad)).toBe(false);
  });
  it('explains itself in plain English', () => {
    expect(zMoney.safeParse('12.5').error?.issues[0]?.message).toBe(
      'Must be a decimal amount with exactly 4 decimals, like 12.4900.',
    );
  });
});

describe('zDecimal', () => {
  it('accepts plain decimals of any scale', () => {
    for (const ok of ['0', '19', '19.5', '19.0000', '-2.25', '3.67250000']) expect(accepts(zDecimal, ok)).toBe(true);
  });
  it('rejects exponents, spaces, separators and numbers', () => {
    for (const bad of ['1e5', '1 000', '1,5', '.5', '5.', 'abc', 19, '1'.repeat(41)])
      expect(accepts(zDecimal, bad)).toBe(false);
  });
});

describe('zIsoDateTime', () => {
  it('accepts UTC with milliseconds and Z', () => {
    expect(accepts(zIsoDateTime, '2026-03-01T09:30:00.000Z')).toBe(true);
    expect(accepts(zIsoDateTime, '2028-02-29T23:59:59.999Z')).toBe(true);
  });
  it('rejects other forms and impossible dates', () => {
    for (const bad of [
      '2026-03-01T09:30:00Z',
      '2026-03-01T09:30:00.000+02:00',
      '2026-03-01 09:30:00.000Z',
      '2026-03-01',
      '2027-02-29T00:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
      '',
      new Date(),
      0,
    ]) {
      expect(accepts(zIsoDateTime, bad)).toBe(false);
    }
  });
});

describe('zId and zIdParam', () => {
  it('zId accepts positive safe integers', () => {
    for (const ok of [1, 42, MAX_ID]) expect(accepts(zId, ok)).toBe(true);
    for (const bad of [0, -1, 1.5, MAX_ID + 1, Number.NaN, Number.POSITIVE_INFINITY, '5', null])
      expect(accepts(zId, bad)).toBe(false);
  });
  it('zIdParam turns path text into the number', () => {
    expect(zIdParam.parse('42')).toBe(42);
    expect(zIdParam.parse('9007199254740991')).toBe(MAX_ID);
  });
  it('zIdParam rejects everything that is not a plain positive integer', () => {
    for (const bad of ['0', '-5', '007', '1.5', '1e3', 'abc', '', ' 5', '9007199254740992', '99999999999999999999', 5])
      expect(accepts(zIdParam, bad)).toBe(false);
  });
});

describe('zDateOnly', () => {
  it('accepts real calendar days', () => {
    for (const ok of ['2026-03-01', '2028-02-29', '1999-12-31']) expect(accepts(zDateOnly, ok)).toBe(true);
  });
  it('rejects impossible or differently written days', () => {
    for (const bad of ['2026-02-30', '2027-02-29', '2026-3-1', '01/03/2026', '2026-03-01T00:00:00.000Z', ''])
      expect(accepts(zDateOnly, bad)).toBe(false);
  });
});

describe('zJsonObject', () => {
  it('accepts nested plain JSON', () => {
    expect(accepts(zJsonObject, { a: 1, b: [1, 'x', null, { c: true }], d: {} })).toBe(true);
    expect(accepts(zJsonObject, Object.assign(Object.create(null), { a: 1 }))).toBe(true);
  });
  it('rejects non-objects and non-JSON values', () => {
    for (const bad of [
      [],
      'x',
      1,
      null,
      undefined,
      { d: new Date() },
      { n: Number.NaN },
      { i: Number.POSITIVE_INFINITY },
      { u: undefined },
      { f: () => 1 },
      { m: new Map() },
      { big: 1n },
    ]) {
      expect(accepts(zJsonObject, bad)).toBe(false);
    }
  });
  it('rejects absurdly deep nesting', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    expect(accepts(zJsonObject, deep)).toBe(false);
  });
});

describe('JSON Schema of the shared types', () => {
  const schema = toJsonSchema(
    z.object({ money: zMoney, rate: zDecimal, at: zIsoDateTime, id: zId, day: zDateOnly, meta: zJsonObject }),
    'output',
  ) as {
    properties: Record<string, Record<string, unknown>>;
  };

  it('carries x-gsm-alias for each shared type', () => {
    expect(
      Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, value['x-gsm-alias']])),
    ).toEqual({
      money: 'Money',
      rate: 'Decimal',
      at: 'IsoDateTime',
      id: 'Id',
      day: 'DateOnly',
      meta: 'JsonObject',
    });
  });

  it('describes Money by its pattern and Id as an integer up to 2^53 - 1', () => {
    expect(schema.properties.money).toMatchObject({ type: 'string', pattern: '^-?\\d+\\.\\d{4}$' });
    expect(schema.properties.id).toMatchObject({ type: 'integer', exclusiveMinimum: 0, maximum: 9007199254740991 });
  });

  it('drops the long ISO pattern next to format date-time / date', () => {
    expect(schema.properties.at).toMatchObject({ type: 'string', format: 'date-time' });
    expect(schema.properties.at?.pattern).toBeUndefined();
    expect(schema.properties.day).toMatchObject({ type: 'string', format: 'date' });
    expect(schema.properties.day?.pattern).toBeUndefined();
  });

  it('describes JsonObject as an open object', () => {
    expect(schema.properties.meta).toMatchObject({ type: 'object', additionalProperties: true });
  });

  it('removes $schema at the root only', () => {
    expect('$schema' in (schema as object)).toBe(false);
    expect(JSON.stringify(schema)).not.toContain('$schema');
  });

  it('describes a path id by the text a client sends', () => {
    const input = toJsonSchema(z.object({ id: zIdParam }), 'input') as { properties: { id: Record<string, unknown> } };
    expect(input.properties.id).toMatchObject({ type: 'string', 'x-gsm-alias': 'Id' });
  });
});
