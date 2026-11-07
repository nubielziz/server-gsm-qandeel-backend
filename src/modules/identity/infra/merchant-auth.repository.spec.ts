// Unit tests of the one pure function of the merchant repository: how a unique violation is told from other errors.
import { describe, expect, it } from 'bun:test';
import { uniqueViolationOf } from './merchant-auth.repository';

describe('uniqueViolationOf', () => {
  it('names the constraint of a unique violation, also when Drizzle wraps the driver error as its cause', () => {
    const driver = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'clients_email_uq' });
    expect(uniqueViolationOf(driver)).toBe('clients_email_uq');
    expect(uniqueViolationOf(new Error('Failed query', { cause: driver }))).toBe('clients_email_uq');
    expect(uniqueViolationOf(new Error('outer', { cause: new Error('middle', { cause: driver }) }))).toBe(
      'clients_email_uq',
    );
  });

  it('answers an empty name when the driver gave none, and undefined for any other error', () => {
    expect(uniqueViolationOf({ code: '23505' })).toBe('');
    expect(uniqueViolationOf(Object.assign(new Error('x'), { code: '23503', constraint: 'fk' }))).toBeUndefined();
    expect(uniqueViolationOf(new Error('boom'))).toBeUndefined();
    expect(uniqueViolationOf(undefined)).toBeUndefined();
    expect(uniqueViolationOf('text')).toBeUndefined();
  });
});
