// Unit tests of the staff edit rules of a merchant (feature 20): the three kinds of change and the comparison with the stored row.
import { describe, expect, it } from 'bun:test';
import type { Client } from '../db/schema';
import { detailChanges, kindOfClientChange } from './client-details';

const stored = {
  name: 'Zain Mobile Hub',
  email: 'Ops@ZainMobileHub.example',
  company: 'Zain',
  phone: '',
  country: 'JO',
  address: '',
  taxId: '',
  internalNotes: '',
} as unknown as Client;

describe('kindOfClientChange', () => {
  it('knows a status change, a group move and a details edit', () => {
    expect(kindOfClientChange({ status: 'active' })).toEqual({ kind: 'status' });
    expect(kindOfClientChange({ status: 'suspended', reason: 'Chargebacks' })).toEqual({ kind: 'status' });
    expect(kindOfClientChange({ groupId: 3 })).toEqual({ kind: 'group' });
    expect(kindOfClientChange({ name: 'Zain', phone: '+962' })).toEqual({ kind: 'details' });
  });

  it('refuses a body of two kinds on the first key of the second kind', () => {
    expect(kindOfClientChange({ status: 'active', groupId: 3 })).toMatchObject({ problem: { field: 'groupId' } });
    expect(kindOfClientChange({ groupId: 3, company: 'X' })).toMatchObject({ problem: { field: 'company' } });
    expect(kindOfClientChange({ status: 'active', taxId: '1', email: 'a@b.co' })).toMatchObject({
      problem: { field: 'email' },
    });
  });

  it('refuses an empty body', () => {
    expect(kindOfClientChange({ reason: 'ignored without a status' })).toMatchObject({ problem: { field: 'status' } });
    expect(kindOfClientChange({})).toMatchObject({ problem: { field: 'status' } });
  });
});

describe('detailChanges', () => {
  it('keeps only the keys whose value differs from the stored one', () => {
    const result = detailChanges(stored, {
      name: 'Zain Mobile Hub',
      phone: '+962 7',
      country: 'JO',
      address: 'Abdali',
    });
    expect(result).toEqual({
      columns: { phone: '+962 7', address: 'Abdali' },
      before: { phone: '', address: '' },
      after: { phone: '+962 7', address: 'Abdali' },
      emailChanged: false,
      nameChanged: false,
    });
  });

  it('collapses the whitespace of the name and compares it as stored', () => {
    expect(detailChanges(stored, { name: '  Zain   Mobile  Hub ' })).toMatchObject({ nameChanged: false, columns: {} });
    expect(detailChanges(stored, { name: ' Zain   Hub ' })).toMatchObject({
      nameChanged: true,
      columns: { name: 'Zain Hub' },
    });
  });

  it('refuses a name that is empty after cleaning', () => {
    expect(detailChanges(stored, { name: '   ' })).toEqual({ problem: { field: 'name', message: 'Enter a name.' } });
  });

  it('compares the email case-insensitively and stores it lower-case', () => {
    expect(detailChanges(stored, { email: 'ops@zainmobilehub.example' })).toMatchObject({ emailChanged: false });
    expect(detailChanges(stored, { email: 'New@Zain.example' })).toMatchObject({
      emailChanged: true,
      columns: { email: 'new@zain.example' },
      after: { email: 'new@zain.example' },
    });
  });

  it('reports no change for a body equal to the row', () => {
    expect(detailChanges(stored, { company: 'Zain', address: '', taxId: '', internalNotes: '' })).toEqual({
      columns: {},
      before: {},
      after: {},
      emailChanged: false,
      nameChanged: false,
    });
  });
});
