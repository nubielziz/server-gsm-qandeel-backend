// The retired commissions module (decision 062): nothing but its schema is left. The three tables stay in the database, unread and
// unwritten, until the accounts migration drops them. No module, controller or service is exported any more.
export * from './db/schema';
