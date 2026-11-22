// The one-off pass that converts link tokens stored as issued before decision 054 (pure loop; each module gives it its own table).
import type { CapabilityTokenKind, CapabilityTokenVault, SealedCapabilityToken } from './capability-token-vault';

/** A row that still keeps its token as issued. */
export interface UnsealedCapabilityToken {
  readonly id: number;
  readonly token: string;
}

/** What a module gives the pass: its own table's reads and guarded writes. */
export interface CapabilityTokenTable {
  /** The rows with an id above afterId that still keep the token as issued, by id, at most limit. */
  unsealed(afterId: number, limit: number): Promise<readonly UnsealedCapabilityToken[]>;
  /** Writes the stored forms and empties the plain column, only while the row still holds that token unsealed; false otherwise. */
  seal(row: UnsealedCapabilityToken, sealed: SealedCapabilityToken): Promise<boolean>;
}

/** How many rows one read returns. */
export const SEAL_PAGE = 500;

/** What a pass did. */
export interface SealOutcome {
  /** Rows converted. */
  readonly sealed: number;
  /** Rows that changed between the read and the guarded write, and were left as they were. */
  readonly unchanged: number;
}

/**
 * Converts every unsealed row of one table, a page at a time.
 *
 * Why: decision 054: tokens stored as issued before this release get their keyed hash and encrypted copy and lose the plain form;
 * each row is its own guarded statement, so a repeat finds nothing left and a concurrent change is never overwritten.
 *
 * @param vault makes the stored forms
 * @param kind which link the table keeps
 * @param table the owning module's reads and writes
 * @returns how many rows were sealed and how many changed meanwhile
 * @throws {Error} whatever the table's statements throw (the job fails and is retried)
 */
export async function sealCapabilityTokens(
  vault: CapabilityTokenVault,
  kind: CapabilityTokenKind,
  table: CapabilityTokenTable,
): Promise<SealOutcome> {
  let sealed = 0;
  let unchanged = 0;
  let afterId = 0;
  for (;;) {
    const page = await table.unsealed(afterId, SEAL_PAGE);
    for (const row of page) {
      if (await table.seal(row, vault.seal(kind, row.token))) sealed += 1;
      else unchanged += 1;
      afterId = row.id;
    }
    if (page.length < SEAL_PAGE) return { sealed, unchanged };
  }
}
