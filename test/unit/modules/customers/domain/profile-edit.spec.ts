// Unit tests of the shared profile-edit rule (feature 24B): which of name, country and phone change, and the audit values.
import { describe, expect, it } from 'bun:test';
import { profileChanges } from '@src/modules/customers/domain/profile-edit';

const customer = { name: 'Daniel Whitmore', phone: '+447700900123', country: 'GB' };

describe('profileChanges', () => {
  it('finds nothing to change when the fields are absent or equal to the stored ones', () => {
    const empty = { columns: {}, before: {}, after: {} };
    expect(profileChanges(customer, {}, undefined)).toEqual(empty);
    expect(profileChanges(customer, { name: 'Daniel Whitmore', phone: '+447700900123', country: 'GB' }, 'EUR')).toEqual(
      empty,
    );
  });

  it('writes a changed name and records the old and new value', () => {
    expect(profileChanges(customer, { name: 'Dan Whitmore' }, undefined)).toEqual({
      columns: { name: 'Dan Whitmore' },
      before: { name: 'Daniel Whitmore' },
      after: { name: 'Dan Whitmore' },
    });
  });

  it('sets the derived currency with a changed country, and null when none could be derived', () => {
    expect(profileChanges(customer, { country: 'DE' }, 'EUR')).toEqual({
      columns: { country: 'DE', currency: 'EUR' },
      before: { country: 'GB' },
      after: { country: 'DE' },
    });
    expect(profileChanges(customer, { country: 'DE' }, null).columns).toEqual({ country: 'DE', currency: null });
    expect(profileChanges(customer, { country: 'DE' }, undefined).columns).toEqual({ country: 'DE', currency: null });
  });

  it('never touches the currency for an unchanged country', () => {
    expect(profileChanges(customer, { country: 'GB' }, 'EUR').columns).toEqual({});
  });

  it('writes a changed phone and clears it with the empty string', () => {
    expect(profileChanges(customer, { phone: '+1 555' }, undefined).columns).toEqual({ phone: '+1 555' });
    expect(profileChanges(customer, { phone: '' }, undefined)).toEqual({
      columns: { phone: '' },
      before: { phone: '+447700900123' },
      after: { phone: '' },
    });
    expect(profileChanges({ ...customer, phone: '' }, { phone: '' }, undefined).columns).toEqual({});
  });

  it('collects every changed field together', () => {
    const changes = profileChanges(customer, { name: 'D W', phone: '', country: 'SE' }, 'USD');
    expect(changes.columns).toEqual({ name: 'D W', phone: '', country: 'SE', currency: 'USD' });
    expect(Object.keys(changes.before).sort()).toEqual(['country', 'name', 'phone']);
    expect(changes.after).toEqual({ name: 'D W', country: 'SE', phone: '' });
  });
});
