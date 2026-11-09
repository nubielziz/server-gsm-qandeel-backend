// The built-in Owner role (decision 018, MISMATCHES B113): one definition for `bun run setup` (first run, P4b) and the development seed.

/**
 * The name of the Owner role.
 *
 * Why: the console's role list and the demo call the all-access role "Owner"; setup creates it under this name when no role
 * grants every permission, and the seed uses it for role 1.
 */
export const OWNER_ROLE_NAME = 'Owner';

/**
 * The permissions of the Owner role: the wildcard that grants everything.
 *
 * Why: an Owner is a staff member whose role contains `*` (decision 018); every guard reads the role's permissions on each
 * request, so nothing else marks an Owner.
 */
export const OWNER_ROLE_PERMISSIONS: readonly string[] = ['*'];
