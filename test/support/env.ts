// The test instances of this run (decision 014): the *_TEST variables from the environment, for example the `.env.test`
// of a worktree, so parallel worktrees point their tests (and the child processes they start) at their own databases.
import { readFileSync } from 'node:fs';

// TYPESENSE_URL_TEST (feature 29): the Typesense node of the search suites; their names follow from DATABASE_URL_TEST.
const TEST_INSTANCE_VARIABLES = [
  'DATABASE_URL_TEST',
  'REDIS_QUEUE_URL_TEST',
  'REDIS_CACHE_URL_TEST',
  'S3_BUCKET_TEST',
  'TYPESENSE_URL_TEST',
];

/**
 * The active `KEY=value` lines of an env template of the repository, with the trailing `# comment` removed.
 *
 * Why: the production template is the operator's starting point (decision 036); tests build a production configuration from
 * it to prove that what the template says is what the API does.
 *
 * @param relativePath the template's path from the repository root, e.g. `.env.production.example`
 * @returns the variables by name
 */
export function templateVariables(relativePath: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = readFileSync(new URL(relativePath, new URL('../../', import.meta.url)), 'utf8');
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) out[match[1] as string] = (match[2] as string).replace(/\s+#.*$/, '').trim();
  }
  return out;
}

/**
 * The test-instance settings found in this process's environment.
 *
 * Why: tests build their config from scratch (`parseEnv({ NODE_ENV: 'test' })`) and start children with `--no-env-file`;
 * without these variables every worktree would use the defaults (`gsm_test`, Redis DB 1) and parallel runs would
 * disturb each other.
 *
 * @returns only the variables that are set, ready to spread into `parseEnv` input or a child's environment
 */
export function testInstanceEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of TEST_INSTANCE_VARIABLES) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}
