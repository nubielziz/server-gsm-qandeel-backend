// The field rules of a shop sign-up (decision 079), for the route contract of the customers module: the rule is identity's (the names,
// the phone, the length), the contract that applies it on the way in is the shop's. A leaf seam: it re-exports pure functions of identity's
// domain and imports nothing else, so a contract file can import it without loading identity's barrel.
export {
  SIGN_UP_FULL_NAME_MAX_LENGTH,
  SIGN_UP_NAME_MAX_LENGTH,
  SIGN_UP_PHONE_DIGITS,
  type SignUpNamePart,
  cleanSignUpName,
  cleanSignUpPhone,
  signUpFullNameProblem,
  signUpNameProblem,
  signUpPhoneProblem,
} from '../domain/sign-up';
