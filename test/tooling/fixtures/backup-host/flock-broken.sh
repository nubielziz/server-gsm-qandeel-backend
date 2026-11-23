#!/usr/bin/env bash
# Stub of flock for test/tooling/backup-host.test.ts: fails as flock does on an error that is not a busy lock.
echo "flock: bad file descriptor" >&2
exit 64
