// Unit tests of the staff edit rules of an account (feature 20, decision 064): the kinds of change, the refusal of a rank in the body, the
// comparison with the stored row and the mark of an address staff set (decision 046).
import { describe, expect, it } from 'bun:test';
import type { Client } from '@src/modules/identity/db/schema';
import { detailChanges, emailMarkAfterEdit, kindOfClientChange } from '@src/modules/identity/domain/client-details';

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
  it('knows a status change and a details edit', () => {
    expect(kindOfClientChange({ status: 'active' })).toEqual({ kind: 'status' });
    expect(kindOfClientChange({ status: 'suspended', reason: 'Chargebacks' })).toEqual({ kind: 'status' });
    expect(kindOfClientChange({ name: 'Zain', phone: '+962' })).toEqual({ kind: 'details' });
  });

  it('refuses a rank in the body with the code use_rank_route, whatever else the body carries', () => {
    const refused = { problem: { field: 'groupId', code: 'use_rank_route' } };
    expect(kindOfClientChange({ groupId: 3 })).toMatchObject(refused);
    expect(kindOfClientChange({ status: 'active', groupId: 3 })).toMatchObject(refused);
    expect(kindOfClientChange({ groupId: 3, company: 'X' })).toMatchObject(refused);
  });

  it('refuses a body of two kinds on the first key of the second kind', () => {
    expect(kindOfClientChange({ status: 'active', taxId: '1', email: 'a@b.co' })).toMatchObject({
      problem: { field: 'email' },
    });
    expect(kindOfClientChange({ status: 'suspended', company: 'X' })).toMatchObject({ problem: { field: 'company' } });
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

describe('emailMarkAfterEdit', () => {
  const edit = { marked: false, emailSent: true, emailChanged: true, byOwner: false };

  it('sets the mark on an email change by a staff member who is not an Owner, and clears it on one by an Owner', () => {
    expect(emailMarkAfterEdit(edit)).toBe(true);
    expect(emailMarkAfterEdit({ ...edit, marked: true })).toBe(true);
    expect(emailMarkAfterEdit({ ...edit, byOwner: true })).toBe(false);
    expect(emailMarkAfterEdit({ ...edit, marked: true, byOwner: true })).toBe(false);
  });

  it('clears a set mark when an Owner sends the stored address', () => {
    expect(emailMarkAfterEdit({ marked: true, emailSent: true, emailChanged: false, byOwner: true })).toBe(false);
  });

  it('leaves the mark otherwise', () => {
    expect(emailMarkAfterEdit({ marked: false, emailSent: true, emailChanged: false, byOwner: true })).toBeUndefined();
    expect(emailMarkAfterEdit({ marked: true, emailSent: true, emailChanged: false, byOwner: false })).toBeUndefined();
    expect(emailMarkAfterEdit({ marked: true, emailSent: false, emailChanged: false, byOwner: true })).toBeUndefined();
    expect(emailMarkAfterEdit({ marked: true, emailSent: false, emailChanged: false, byOwner: false })).toBeUndefined();
  });
});
