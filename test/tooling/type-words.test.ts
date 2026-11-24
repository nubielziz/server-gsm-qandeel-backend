// The one stored type word (decision 064): every (type, id) pair a new row stores says `account`. The old words `client` and
// `customer` stay readable in the append-only rows written before the cut-over (the legacy resolver and the schema files name them), but
// no code may write one, and no audit entry may be about an entity or by an actor called `merchant`, `customer` or `client`. The scan
// reads the code of src for a pair written as `type: 'client'`, `ownerType: 'customer'`, `entityType: 'merchant'` and the like (a
// comparison such as `type === 'client'` is a reader and is not looked for). Proved on synthetic text that fails first. No database.
import { describe, expect, it } from 'bun:test';
import { type Hit, isSchemaFile, readSource, report, scanText, sourceFiles } from './lib/source-scan';

/** The keys that carry the type word of a (type, id) pair, in TypeScript and in a column list. */
const PAIR_KEYS = [
  'type',
  'ownerType',
  'subjectType',
  'recipientType',
  'requesterType',
  'authorType',
  'requestedByType',
  'createdByType',
  'refType',
  'owner_type',
  'subject_type',
  'recipient_type',
  'requester_type',
  'author_type',
  'requested_by_type',
  'created_by_type',
  'ref_type',
];
/** The keys that carry the entity or the actor of an audit entry. */
const AUDIT_KEYS = ['entityType', 'entity_type', 'entity', 'actorType', 'actor_type', 'actor'];

/** A key (bare or quoted), a colon, and one of the words as a string literal. */
const written = (keys: string[], words: string[]): RegExp =>
  new RegExp(`\\b(?:${keys.join('|')})['"]?\\s*:\\s*'(?:${words.join('|')})'`);

/** A pair written with an old word. */
const OLD_PAIR = written(PAIR_KEYS, ['client', 'customer']);
/** An audit entity or actor written with an old word. */
const OLD_AUDIT = written(AUDIT_KEYS, ['merchant', 'customer', 'client']);

/** A file that may name the old words: a schema file (the lists of values) or the legacy resolver of the identity module. */
const mayNameThem = (path: string): boolean => isSchemaFile(path) || path.startsWith('src/modules/identity/accounts/');

describe('the patterns, on synthetic text', () => {
  const pairs = (text: string): number => scanText('x.ts', text, OLD_PAIR).length;
  const audits = (text: string): number => scanText('x.ts', text, OLD_AUDIT).length;

  it('finds a pair written with client or customer, in an object, a type and a quoted key', () => {
    expect(pairs("await ledger.hold(tx, order, { type: 'client', id: merchant.id });")).toBe(1);
    expect(pairs("actor: { type: 'customer', id: input.customerId }")).toBe(1);
    expect(pairs("const owner: { readonly type: 'customer'; readonly id: number } = x;")).toBe(1);
    expect(pairs("values({ ownerType: 'client', ownerId: 1 })")).toBe(1);
    expect(pairs("{ 'subject_type': 'customer' }")).toBe(1);
    expect(pairs("{ recipient: { type: 'customer', id }, requesterType: 'client' }")).toBe(2);
  });

  it('finds an audit entity or actor called merchant, customer or client', () => {
    expect(audits("record({ entityType: 'merchant', entityId: id })")).toBe(1);
    expect(audits("record({ entityType: 'customer' })")).toBe(1);
    expect(audits("record({ actorType: 'client', actor: 'customer' })")).toBe(2);
  });

  it('leaves the new word, other keys, comparisons, lists of values and comments alone', () => {
    expect(pairs("{ type: 'account', id }")).toBe(0);
    expect(audits("{ entityType: 'account', actorType: 'account' }")).toBe(0);
    // another key with the same word is not a pair: the surface, the kind of the sign-in answer, a table name
    expect(pairs("{ surface: 'client', kind: 'customer', table: 'customer' }")).toBe(0);
    expect(audits("{ kind: 'merchant', role: 'customer', entityType: 'merchant_group' }")).toBe(0);
    // a reader compares, a list of values is data, a longer word is another word
    expect(pairs("if (row.type === 'client') return; const words = ['client', 'customer'];")).toBe(0);
    expect(pairs("{ type: 'clients', refType: 'customer_wallet' }")).toBe(0);
    expect(pairs("// { type: 'client', id } was the old pair\n/* ownerType: 'customer' */")).toBe(0);
  });
});

describe('the code of src', () => {
  const files = sourceFiles('src').filter((file) => !mayNameThem(file));

  it('is read in full', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("writes no pair with the word client or customer ('account' is the one word)", () => {
    const hits: Hit[] = files.flatMap((file) => scanText(file, readSource(file), OLD_PAIR));
    expect(report(hits)).toEqual([]);
  });

  it('writes no audit entity or actor called merchant, customer or client', () => {
    const hits: Hit[] = files.flatMap((file) => scanText(file, readSource(file), OLD_AUDIT));
    expect(report(hits)).toEqual([]);
  });
});
