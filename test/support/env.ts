// The test instances of this run (decision 014): the *_TEST variables from the environment, for example the `.env.test`
// of a worktree, so parallel worktrees point their tests (and the child processes they start) at their own databases.

const TEST_INSTANCE_VARIABLES = ['DATABASE_URL_TEST', 'REDIS_QUEUE_URL_TEST', 'REDIS_CACHE_URL_TEST', 'S3_BUCKET_TEST'];

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
