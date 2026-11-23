# 059: Backups on Cloudflare R2, driven by the server

Status: accepted, 2026-11-23. Builds on decisions 036, 055 and 057; replaces, on R2, the bucket rules of decision 055 (versioning and a
key that cannot delete).

**Context.** The container scripts of the backups (decisions 036 and 055) were designed and tested, but they never ran in production:
nothing scheduled them, nothing told anyone when a night failed, and the bucket rules of the runbook assume a provider with object
versioning and a key that may write but not delete. The owner chose Cloudflare R2 for the offsite bucket and wants the whole thing
driven from the server only: no console screen, no API route, no table, no job.

**Decision.**

- **R2 is the offsite bucket.** It speaks S3 (rclone provider `Cloudflare`, region `auto`, endpoint
  `https://<account id>.r2.cloudflarestorage.com`) and is another provider than the server's. Two protections of the runbook do not
  exist there: R2 has no object versioning, and its object key ("Object Read & Write") can also delete; no R2 key may only write.
  **Bucket lock rules take their place**: until its lock ends, a locked object can be neither deleted nor overwritten, whatever key asks,
  so a stolen server key cannot destroy or replace the copies of the past days. The server keeps an object key for this bucket only.
- **The rules** are set by the owner with `deploy/backup/r2-bucket-rules.sh` and a Cloudflare API token made for the moment (it never
  stays on the server); for a bucket created in a jurisdiction (for example `eu`), `R2_JURISDICTION` adds the header
  `cf-r2-jurisdiction` the API needs to find it. `DAILY_DAYS` is the daily retention (30):

  | Prefix | Lifecycle: removed after | Lock: no delete, no overwrite for |
  | --- | --- | --- |
  | `db/incoming/` | 2 days | (none: a dump waits there only until it is checked) |
  | `db/daily/` | `DAILY_DAYS` + 5 days | `DAILY_DAYS` days |
  | `db/monthly/` | 400 days | 395 days |
  | `config/` | `DAILY_DAYS` + 5 days | `DAILY_DAYS` days |
  | `files-age/` | never | for good |
  | unfinished multipart uploads | aborted after 2 days | |

  A lock ends a few days before the lifecycle rule of its prefix removes the object, so the two never meet: a locked object is not
  removed by a lifecycle rule. `files-age/` is locked for good: the purge after an erasure request (decision 055) is an act of the owner,
  who switches that one rule off for the time of the purge and on again (`r2-bucket-rules.sh apply` puts it back).
- **The host side.** `deploy/backup/gsm-backup.sh`, installed as `/usr/local/sbin/gsm-backup` and run by root from two systemd timers:
  `run` every night (01:15 UTC, spread over 15 minutes; a night the server was off is caught up when it starts) and `check` every
  morning (07:30 UTC). `run` builds the tools image of the checkout, then takes the database dump, the encrypted files copy and the
  configuration copy; a step that fails does not stop the next ones. Its state is in `/var/lib/gsm-backup` (the last run, the last
  success, the last drill, one log per run). **An interrupted night reaches a person too**: from the moment it holds its lock, a run's
  last-run record says "failed, interrupted", and only the end of the run overwrites it; a run stopped by a signal (a shutdown,
  `systemctl stop`) sends one alert naming the step it was in, and one killed without a chance to speak (SIGKILL, a power loss) leaves
  that record for the morning check. Only a busy lock makes a second run step aside (exit code 75); a lock that cannot be taken for
  any other reason is an error. The automatic deploys keep the installed script current (decision 057); the units are
  installed by hand.
- **The check reads the bucket, not a note of the server.** `check` lists the bucket in the container (`offsite-status.sh`, read-only)
  and fails when the listing fails, when there is no daily dump, when the newest dump is older than 26 hours (by the UTC stamp in its
  name), dated more than an hour in the future (a clock set back would otherwise make every later night look fresh) or empty, or when
  the last run failed or was interrupted; a run that still holds the lock is going on, not interrupted. It also removes a copy of the
  private key it finds outside a drill (a drill holds a lock of its own) and reports it: the key never stays on the server. A note on the server saying "done" would be the server vouching for itself; the bucket is
  what a restore uses. An unreadable bucket is never taken for an empty one, the rule of the files mirror.
- **Alerts go through the application's own SMTP account** (`MAIL_SMTP_URL` and `MAIL_FROM` of `.env.production`, read and never
  sourced): one plain-text mail for each failed night and each failed check, and a line in the journal. There is no second mail account
  to keep, and the credentials reach `curl` through a config on its standard input, never its arguments. A server that is down sends no
  mail, so an optional `HEARTBEAT_URL` of a monitor outside the server is called after each night that succeeded; the monitor warns when
  a call is missing.
- **The configuration copy.** Every night the server's own configuration (`deploy/.env`, `.env.production`, the settings files of the
  backups and of the deployer, the folder `server/`) is packed, encrypted **on the host** for the same age public key, and stored in
  `config/` by `config-copy.sh`, which refuses anything that is not an age file. Symbolic links are followed: the copy holds the
  content of a settings file that is a link, which a restore needs, not the link. Why: a restored database is of little use without
  `ENCRYPTION_KEYS` (the sealed columns), `LOOKUP_HASH_KEY` and `TOKEN_PEPPER` of the same installation, and a new server needs the rest.
  It is encrypted on the host because the backup container must never see `.env.production` (decision 055). **For key custody** this
  means that the age private key now opens every secret of the server, not only its data: it is kept exactly like `ENCRYPTION_KEYS` (two
  offline copies, two people), and the offline copy of `ENCRYPTION_KEYS` stays, so the loss of one key does not take the other with it.
- **The restore drill stays a monthly act of a person.** `gsm-backup drill <key file>` copies the private key for the container
  (mode 0400, its user 10001), runs the drill and always removes the copy: after a pass, a failure or a signal. It cannot be a timer,
  because the private key never stays on the server: a server that could read its own backups would hand them to whoever takes it. The
  morning check reminds when no drill was recorded for 35 days.

**The read-back after an upload is left out on R2** (`setup_backup_remote`, `BACKUP_S3_PROVIDER=Cloudflare`). R2 answers an upload with
a version id and refuses every request that names one, because it keeps no versions; the rclone of the tools image reads an upload back
by that id, so each upload failed once and passed on the retry (seen on the first real run, 2026-11-23). The upload stays checked: R2
compares the body with the Content-MD5 that rclone sends, the dump and the configuration copy are looked up in the bucket after the copy,
and the restore drill opens a real dump every month.

**What is not done.** No console screen, API route, table or job: the backups stay outside the application (owner's word). No
point-in-time recovery: the unit of a backup is one night's dump, so losing the database can lose **up to a day of data** (that day's
orders, payments and ledger entries); the payment provider's records and the mails sent are what is left to rebuild that day by hand.
No versioning and no key that cannot delete on R2, because R2 has neither: the lock rules are the protection, and they hold only while
the Cloudflare account is safe. Whoever controls the account, or holds a token that may edit R2, can change them; that token is made
for the moment and deleted after it.

**Consequences.** A failed night or a dump missing from the bucket reaches a person the same morning, and a dead server is noticed by
the heartbeat monitor. The age private key guards the server's secrets as well as its data. A new server can be rebuilt from the
bucket and the offline key alone. The provider-neutral rules of the runbook stay for any other provider; on R2, `BACKUP_PRUNE` stays 0.
