# 004: Local S3: MinIO from Chainguard's image

Status: accepted, 2026-10-31.

**Context.** The stack wants MinIO locally. MinIO stopped publishing community images in 2025: `minio/minio` on
Docker Hub, the `quay.io/minio/minio` tags and Bitnami's image can no longer be pulled.

**Options.** Build MinIO from source; Chainguard's source-built `cgr.dev/chainguard/minio` (free `latest` tag);
another S3-compatible server (RustFS, SeaweedFS, Garage).

**Decision.** Chainguard's MinIO and MinIO client images, pinned by digest in `compose.yaml`. The one-shot
`minio-init` service creates the buckets (`gsm-files`, `gsm-files-test`) through `MC_HOST_local`, because the image
has no shell. The app speaks plain S3 through `@aws-sdk/client-s3` (`forcePathStyle: true`), so production can use
any S3-compatible store.

**Consequences.** To update, pull `latest` and record the new digest. The image runs as uid 65532, so local compose
runs it as root for the named volume. If Chainguard's free tier disappears, switch to RustFS (no code change).
