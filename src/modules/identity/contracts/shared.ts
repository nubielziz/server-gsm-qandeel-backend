// Field schemas shared by the identity route contracts: people references, names and emails as the console cleans them.
import { z } from 'zod';
import { zId } from '../../../common/contract';

/** A person as the API names them in a join: id and display name. */
export const PersonRef = z.object({ id: zId, name: z.string() });

/**
 * An email address: trimmed and lower-cased, then shaped like `a@b.c`.
 *
 * Why: the console sends it trimmed and lower-case; the server cleans it again and judges the shape (MISMATCHES B3 style:
 * the client's check is advice). Uniqueness is the database's, case-insensitively.
 */
export const EmailField = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Use at most 254 characters.')
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address.');

/** A person's or company's name: trimmed, 2 to 100 characters (single spaces are enforced by the use case). */
export const NameField = z.string().trim().min(2, 'Enter a name.').max(100, 'Use at most 100 characters.');
