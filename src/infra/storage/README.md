# Object storage (`src/infra/storage`)

S3-compatible storage through `@aws-sdk/client-s3` (decision 004): MinIO locally (path-style), any S3-compatible store in
production. One bucket (`S3_BUCKET`); the `files` table stores `bucket`, `key`, `size` and `sha256` next to the file name.

| What                                                      | Where                 |
| --------------------------------------------------------- | --------------------- |
| `StorageService`: `put`, `get`, `head`, `delete`, `presignGet`, `ping` | `storage.service.ts` |
| Rules for object keys, content types and the download header | `storage-names.ts` |
| Health indicator `storage` (non-critical)                 | `storage.health.ts`   |

```ts
const stored = await this.storage.put(`files/${yyyy}/${mm}/${uuid}`, upload.file, {
  contentType: upload.mimetype,
  maxBytes: 10 * 1024 * 1024,
  expectedSha256: request.checksum, // optional
});
// -> { bucket, key, size, sha256, contentType, etag }

const url = await this.storage.presignGet(stored.key, { filename: file.filename, expiresInSeconds: 120 });
```

## Behaviour

- **Keys** are built by the module from ids (letters, digits and `. _ = + -` in `/` segments; no `..`, no empty segment).
- **Size limit:** default 25 MiB, at most 64 MiB. A body over the limit is `413 PAYLOAD_TOO_LARGE`; a stream is closed as soon as
  it goes over. S3 needs the length before it accepts a body, so a stream is buffered in memory up to the limit; bigger
  files would need a multipart upload (`@aws-sdk/lib-storage`, not added yet).
- **Integrity:** the SHA-256 is computed while reading and sent to S3 (`x-amz-checksum-sha256`), which verifies it. A wrong
  `expectedSha256` is `400 BAD_REQUEST` and nothing is stored.
- **Downloads:** `presignGet` makes a short-lived link (default 5 minutes, at most 7 days) with `Content-Disposition:
  attachment`; the file name is cleaned (no quotes, slashes or control characters). The link works for anyone who holds it:
  never log it.
- `get` and `head` answer `null` for a missing object; `delete` is idempotent.
- **Store down:** every call answers `503 UNAVAILABLE` (the endpoint is not in the message); `GET /health` reports `storage`
  as down (`degraded`).
- Tests use the bucket `gsm-files-test` (`S3_BUCKET_TEST`); under `NODE_ENV=test` `S3_BUCKET` is ignored.
