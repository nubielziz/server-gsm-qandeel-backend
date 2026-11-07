// Unit tests of defineDhruAction (decision 026): the definition-time checks and the registry. Each successful definition registers in the
// process-wide registry, so the tests put it back as it was.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { DhruActionRegistry, type AnyDhruAction, defineDhruAction, dhruActionRegistry } from './define-dhru-action';

let before: readonly AnyDhruAction[] = [];
beforeEach(() => {
  before = dhruActionRegistry.all();
});
afterEach(() => {
  dhruActionRegistry.clear();
  for (const contract of before) dhruActionRegistry.register(contract);
});

const success = z.object({ MESSAGE: z.string() });
const spec = (overrides: Record<string, unknown> = {}) => ({
  key: 'DHRU specaction' as const,
  summary: 'A spec action',
  success,
  errors: ['UNAUTHORIZED'] as const,
  ...overrides,
});

describe('defineDhruAction', () => {
  it('freezes the contract, takes the action from the key and registers it', () => {
    const contract = defineDhruAction(
      spec({
        params: z.object({ ID: z.number() }),
        bulk: true,
        examples: { request: { ID: 1 }, response: { MESSAGE: 'ok' } },
      }) as never,
    );
    expect(contract.action).toBe('specaction');
    expect(contract.bulk).toBe(true);
    expect(Object.isFrozen(contract)).toBe(true);
    expect(dhruActionRegistry.get('specaction')).toBe(contract);
    expect(dhruActionRegistry.all().at(-1)).toBe(contract);
  });

  it('refuses a key that is not "DHRU <action>", an empty or long summary, and an unknown error code', () => {
    expect(() => defineDhruAction(spec({ key: 'DHRU Bad_Name' }) as never)).toThrow('must look like');
    expect(() => defineDhruAction(spec({ key: 'POST /x' }) as never)).toThrow('must look like');
    expect(() => defineDhruAction(spec({ summary: '  ' }) as never)).toThrow('summary');
    expect(() => defineDhruAction(spec({ summary: 'x'.repeat(121) }) as never)).toThrow('summary');
    expect(() => defineDhruAction(spec({ errors: ['NOT_A_CODE'] }) as never)).toThrow('unknown error code');
    expect(dhruActionRegistry.get('specaction')).toBeUndefined();
  });

  it('checks the examples against the schemas, so documentation never shows what the API would not take or send', () => {
    expect(() => defineDhruAction(spec({ examples: { request: { ID: 1 } } }) as never)).toThrow(
      'needs a params schema',
    );
    expect(() =>
      defineDhruAction(spec({ params: z.object({ ID: z.number() }), examples: { request: { ID: 'x' } } }) as never),
    ).toThrow('examples.request does not satisfy');
    expect(() => defineDhruAction(spec({ examples: { response: { WRONG: 1 } } }) as never)).toThrow(
      'examples.response does not satisfy',
    );
  });

  it('refuses to define an action twice', () => {
    defineDhruAction(spec() as never);
    expect(() => defineDhruAction(spec() as never)).toThrow('defined twice');
  });
});

describe('DhruActionRegistry', () => {
  it('keeps definition order, finds by action and can be cleared', () => {
    const registry = new DhruActionRegistry();
    const a = { action: 'a' } as AnyDhruAction;
    const b = { action: 'b' } as AnyDhruAction;
    registry.register(a);
    registry.register(b);
    expect(registry.all()).toEqual([a, b]);
    expect(registry.get('b')).toBe(b);
    expect(registry.get('c')).toBeUndefined();
    expect(() => registry.register(a)).toThrow('defined twice');
    registry.clear();
    expect(registry.all()).toEqual([]);
  });
});
