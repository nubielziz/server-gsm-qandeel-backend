// Limits on the one-time links a visitor can ask for (the sign-in link, forgot password; decision 052). Pure constants.

/** The most live links of one family an account may hold when the visitor asked for them: the oldest goes first. */
export const MAX_LIVE_PUBLIC_LINKS = 3;

/**
 * An id no account has: the budget key of an email without an account, and the subject of a run that is rolled back.
 *
 * Why: decision 052. A request for an email that gets no mail runs the same statements as one that does, on this subject, and keeps
 * nothing. It is positive, so the outbox accepts it as an aggregate id, and it fits every bigint column the run writes.
 */
export const NO_ACCOUNT_ID = Number.MAX_SAFE_INTEGER;
