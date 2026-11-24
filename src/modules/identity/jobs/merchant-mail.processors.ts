// The old names of the three merchant mail processors, kept until the contract release (decision 064): the processors are the ones of
// account-mail.processors.ts, which handles all seven account mails. New code imports that file.
export {
  MerchantEmailVerificationMailProcessor as EmailVerificationMailProcessor,
  MerchantInvitedMailProcessor,
  MerchantPasswordResetMailProcessor as PasswordResetMailProcessor,
} from './account-mail.processors';
