# 057: Checks on GitHub, and a server that deploys by itself

Status: accepted, 2026-11-23. Builds on decisions 014, 027, 036 and 043.

**Context.** The checks ran on the lead's machine only (`bun run check`, `scripts/ci.sh`), and a release was a list of commands typed
on the server (`docs/OPERATIONS.md` section 3). The three repositories are public on GitHub and the production server exists.

**Decision.**

- **The checks run on GitHub Actions**, on every push to `main` and every pull request of each repository. The backend's workflow is
  `bun run check` spread over several machines: the static steps in one job, the tests in six shards, and a build of the production
  image. A shard is `GSM_TEST_SHARD=k/n` of `scripts/test-batches.sh`: every n-th batch, under the number the batch has in a whole
  run, so the shards together are the suite and a batch number means the same files everywhere. A batch that fails runs once more on
  its own (`GSM_TEST_RERUN=1`) and counts as failed only when it fails again: a loaded machine fails a timing-sensitive test now and
  then, and a red pipeline that is not the change teaches people to ignore it.
- **The workflows read no secret** and may only read the repository; actions are pinned to a commit. A pull request from a fork
  therefore runs the same jobs with nothing to take.
- **The server deploys by itself, and nothing is pushed to it.** A timer on the server runs `deploy/cd/auto-deploy.sh`: it fetches
  `main` of each checkout and deploys the newest commit when every workflow run of that commit has finished and succeeded (the
  repository's own workflow among them: a commit without its run is never deployed), the commit continues the history of the one that
  runs, and the checkout is clean. GitHub holds no key of the server and the server opens no
  port for this. The other way round (a job on GitHub that signs in to the server) would put a key that can change production into a
  public repository's settings.
- **A deploy is the runbook's upgrade, in its order**: keep the running image, build, dump the database when the commit adds a
  migration, migrate, replace the containers, wait for them to be healthy; when they are not, put the checkout and the image that ran back. Migrations
  are never rolled back (decision 027: they are additive, so the previous code runs on the new schema).
- **A commit that changes nothing that runs is not built** (documents, tests, the workflows): it is only recorded.
- **People keep the last word**: `hold` stops the deploys, a failed commit is not tried again by itself, and a release that is not
  additive is done by hand.

**Consequences.** A push to `main` reaches production in the time of the checks plus a few minutes, without anyone on the server.
`main` must stay deployable: work that is not ready stays on a branch. The deployer asks GitHub without a key (60 questions an hour),
so it spaces its questions. The dump before a migration is on the server's own disk: it protects against a bad migration, not against
losing the server (section 4 of the runbook does that).
