// drizzle-kit configuration (decision 027): the schema barrel, the migrations folder and snake_case column names.
// `generate` and `check` never connect; the credentials only matter for ad-hoc drizzle-kit commands (studio, push).
import { defineConfig } from 'drizzle-kit';
import { DEV_DEFAULTS, loadConfig } from './src/config';
import { databaseUrlFor } from './src/infra/db/url';

/** The configured database, or the local development one when the environment is invalid (generate needs none). */
function credentials(): string {
  try {
    return databaseUrlFor(loadConfig());
  } catch {
    return DEV_DEFAULTS.databaseUrl;
  }
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infra/db/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
  dbCredentials: { url: credentials() },
});
