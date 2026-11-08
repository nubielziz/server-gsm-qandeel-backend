// Keeps the header of foreign-reads.repository.ts true: it names exactly the other modules' tables the file selects from
// (decision 016 deviation note), no more and no fewer.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./foreign-reads.repository.ts', import.meta.url), 'utf8');

/** `serviceCategories` -> `service_categories`. */
const snake = (name: string): string => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

describe('foreign-reads.repository.ts', () => {
  it('lists in its header the tables it reads and no other', () => {
    const header = source
      .split('\n')
      .filter((line) => line.startsWith('//'))
      .join(' ');
    const sentence = /this file reads (.+?) with plain selects/.exec(header)?.[1] ?? '';
    const listed = [...sentence.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]!).sort();

    // Every table behind a from or a join, except this module's own `service_listings`.
    const read = [...source.matchAll(/\.(?:from|innerJoin|leftJoin|rightJoin)\(\s*s\.(\w+)/g)]
      .map((match) => snake(match[1]!))
      .filter((table) => table !== 'service_listings');
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).toEqual([...new Set(read)].sort());
  });
});
