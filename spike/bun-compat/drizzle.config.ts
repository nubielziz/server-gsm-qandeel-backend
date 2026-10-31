// Bun compatibility spike: drizzle-kit config, run with `bunx --bun drizzle-kit generate|migrate --config ...`.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './spike/bun-compat/schema.ts',
  out: './spike/bun-compat/drizzle',
  schemaFilter: ['spike'],
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://gsm:gsm@localhost:5432/gsm_test' },
  migrations: { schema: 'spike_meta', table: '__drizzle_migrations' },
});
