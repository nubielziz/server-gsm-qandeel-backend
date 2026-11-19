// The shop naming of the bulk publish (feature 31, plan section 3.5): a pure domain module (no database, no Nest) that turns a
// supplier's service name into a clean English shop title, a slug, and the brand, carrier and country read from it.
export { BRAND_KINDS, type BrandKind, type DetectedBrand, detectBrand, toolFromGroup } from './brand';
export { type CountrySource, type DetectedGeo, detectCountries, detectGeo } from './carrier-country';
export {
  HARD_NAMING_FLAGS,
  NAMING_FLAGS,
  NAMING_RULES_VERSION,
  type NamingFlag,
  type NamingInput,
  type ServiceFacts,
  TITLE_LONG_LENGTH,
  TITLE_SOFT_LENGTH,
  detectFacts,
  orderFlags,
  titleFlags,
} from './facts';
export { type BatchInput, type NameAllOptions, type NamedService, nameAll, nameKey, titleKey } from './name-batch';
export { type AssignedSlug, assignSlugs, nextFreeSlug, slugFor } from './slug-for';
export {
  type CleanOptions,
  type NamingKind,
  type PublishServiceType,
  TITLE_CUT_LENGTH,
  cleanTitle,
  cutTitle,
  groupText,
  isRouterCodeList,
  namingKind,
} from './title-rules';
