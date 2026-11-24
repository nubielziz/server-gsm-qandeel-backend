// The old home of the merchant mail job, kept until the contract release (decision 064): the job is `AccountMailJobs` of
// `account-mail-jobs.ts`. Only the helper the staff mail job still imports from here stays; it is a pure function of the domain.
export { formatExpiry } from '../../domain/account-mail';
