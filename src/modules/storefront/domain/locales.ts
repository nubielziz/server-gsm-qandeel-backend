// The languages the storefront content exists in. One list, so the contracts, the public routes and the seed agree.

/** The two languages of the storefront (the console's `en|ar` pickers). */
export const STOREFRONT_LOCALES = ['en', 'ar'] as const;

/** One value of {@link STOREFRONT_LOCALES}. */
export type StorefrontLocale = (typeof STOREFRONT_LOCALES)[number];

/** The language a public request gets when it names none. */
export const DEFAULT_LOCALE: StorefrontLocale = 'en';
