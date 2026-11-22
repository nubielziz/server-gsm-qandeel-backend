// Unit tests of the character rule of the validation guard and pipe (decision 053): U+0000 or an unpaired surrogate anywhere in the params,
// the query or the body is one 422 item for that input; headers and the incoming webhooks are not judged.
import { describe, expect, it } from 'bun:test';
import type { ArgumentMetadata } from '@nestjs/common';
import { AppError } from '@src/common/errors';
import { ContractValidationPipe, validateInputs } from '@src/common/contract';
import { createItem, echoHeaders, listItems, showItem } from '../../../support/routes';
import { hookPing } from '../../../support/pipeline-routes';

const NUL = '\u0000';
const LONE_HIGH = '\ud800';
const LONE_LOW = '\udc00';
const MESSAGE = 'Must not contain the character U+0000 or an unpaired surrogate.';

function refusal(run: () => void): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('validateInputs: the character U+0000 and unpaired surrogates', () => {
  it('refuses U+0000 in the body, the query and a path parameter with one 422 item each', () => {
    const body = refusal(() => validateInputs(createItem, { body: { name: `a${NUL}b`, price: '1.0000' } }));
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.errors).toEqual([{ field: 'name', code: 'invalid_format', message: MESSAGE }]);

    const query = refusal(() => validateInputs(listItems, { query: { q: `sam${NUL}sung` } }));
    expect(query.errors).toEqual([{ field: 'q', code: 'invalid_format', message: MESSAGE }]);

    const params = refusal(() => validateInputs(showItem, { params: { id: `1${NUL}` } }));
    expect(params.errors).toEqual([{ field: 'id', code: 'invalid_format', message: MESSAGE }]);
  });

  it('refuses a lone high surrogate and a lone low one in the body, the query and a path parameter, with the same item as U+0000', () => {
    for (const lone of [LONE_HIGH, LONE_LOW]) {
      const body = refusal(() => validateInputs(createItem, { body: { name: `a${lone}b`, price: '1.0000' } }));
      expect(body.code, lone).toBe('VALIDATION_FAILED');
      expect(body.errors, lone).toEqual([{ field: 'name', code: 'invalid_format', message: MESSAGE }]);
      const query = refusal(() => validateInputs(listItems, { query: { q: `sam${lone}sung` } }));
      expect(query.errors, lone).toEqual([{ field: 'q', code: 'invalid_format', message: MESSAGE }]);
      const params = refusal(() => validateInputs(showItem, { params: { id: `1${lone}` } }));
      expect(params.errors, lone).toEqual([{ field: 'id', code: 'invalid_format', message: MESSAGE }]);
    }
  });

  it('names an object key that holds an unpaired surrogate at the input, and a nested one by its dotted path', () => {
    const key = refusal(() => validateInputs(createItem, { body: { [`k${LONE_HIGH}`]: 1 } }));
    expect(key.errors?.[0]?.field).toBe('body');
    const nested = refusal(() =>
      validateInputs(createItem, {
        body: { name: 'ok', price: '1.0000', lines: [{ imei: 'x' }, { imei: `y${LONE_LOW}` }] },
      }),
    );
    expect(nested.errors?.[0]?.field).toBe('lines.1.imei');
  });

  it('accepts a valid surrogate pair (an emoji) in the body, the query and a path parameter', () => {
    const emoji = '\u{1F600}';
    expect(() => validateInputs(createItem, { body: { name: `Phone ${emoji}`, price: '1.0000' } })).not.toThrow();
    expect(() => validateInputs(listItems, { query: { q: emoji } })).not.toThrow();
    expect(() => validateInputs(showItem, { params: { id: '1' }, body: { note: emoji } })).not.toThrow();
  });

  it('names the dotted path of the first offending text, and the input when the path is empty', () => {
    const nested = refusal(() =>
      validateInputs(createItem, {
        body: { name: 'ok', price: '1.0000', lines: [{ imei: 'x' }, { imei: `y${NUL}` }] },
      }),
    );
    expect(nested.errors?.[0]?.field).toBe('lines.1.imei');
    const key = refusal(() => validateInputs(createItem, { body: { [`k${NUL}`]: 1 } }));
    expect(key.errors?.[0]?.field).toBe('body');
  });

  it('does not run the schema of an input that holds the character (one item, not the schema issues)', () => {
    // price is missing and name is too short: the schema would report two issues; the rule reports one.
    const error = refusal(() => validateInputs(createItem, { body: { name: NUL } }));
    expect(error.errors?.length).toBe(1);
    expect(error.errors?.[0]?.code).toBe('invalid_format');
  });

  it('scans an input the contract does not declare', () => {
    const error = refusal(() =>
      validateInputs(showItem, { params: { id: '1' }, body: { stray: { deep: `x${NUL}` } } }),
    );
    expect(error.errors).toEqual([{ field: 'stray.deep', code: 'invalid_format', message: MESSAGE }]);
  });

  it('reports each input that holds it once', () => {
    const error = refusal(() =>
      validateInputs(createItem, { query: { x: `a${NUL}` }, body: { name: `b${NUL}`, price: '1.0000' } }),
    );
    expect(error.errors?.map((item) => item.field)).toEqual(['x', 'name']);
  });

  it('never scans the headers', () => {
    expect(() => validateInputs(echoHeaders, { headers: { 'idempotency-key': `abcdefgh${NUL}` } })).not.toThrow();
  });

  it('leaves the webhook surface alone', () => {
    expect(() => validateInputs(hookPing, { body: { id: `evt${NUL}1`, [`k${NUL}`]: `v${NUL}` } })).not.toThrow();
    expect(() =>
      validateInputs(hookPing, { body: { id: `evt${LONE_HIGH}1`, [`k${LONE_LOW}`]: `v${LONE_HIGH}` } }),
    ).not.toThrow();
  });

  it('lets clean values through', () => {
    expect(() => validateInputs(createItem, { body: { name: 'Phone', price: '1.0000' } })).not.toThrow();
  });
});

describe('ContractValidationPipe: the same rule for a value the guard did not see', () => {
  const metadata = (type: ArgumentMetadata['type']): ArgumentMetadata => ({ type, metatype: Object });

  it('refuses the same for a value the guard did not see', () => {
    const pipe = new ContractValidationPipe(createItem);
    const error = refusal(() => pipe.transform({ name: `a${NUL}`, price: '1.0000' }, metadata('body')));
    expect(error.errors).toEqual([{ field: 'name', code: 'invalid_format', message: MESSAGE }]);
  });

  it('refuses an unpaired surrogate for a value the guard did not see', () => {
    const pipe = new ContractValidationPipe(createItem);
    const error = refusal(() => pipe.transform({ name: `a${LONE_HIGH}`, price: '1.0000' }, metadata('body')));
    expect(error.errors).toEqual([{ field: 'name', code: 'invalid_format', message: MESSAGE }]);
  });

  it('reuses what the guard parsed and parses a clean value', () => {
    const pipe = new ContractValidationPipe(createItem);
    const body = { name: 'Phone', price: '1.0000' };
    validateInputs(createItem, { body });
    expect(pipe.transform(body, metadata('body'))).toMatchObject({ name: 'Phone' });
    expect(pipe.transform({ name: 'Tablet', price: '2.0000' }, metadata('body'))).toMatchObject({ name: 'Tablet' });
  });

  it('leaves the webhook surface alone', () => {
    const pipe = new ContractValidationPipe(hookPing);
    expect(() => pipe.transform({ id: `a${NUL}` }, metadata('body'))).not.toThrow();
    expect(() => pipe.transform({ id: `a${LONE_HIGH}` }, metadata('body'))).not.toThrow();
  });
});
