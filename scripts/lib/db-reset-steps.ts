// The effects of `bun run db:reset` (P4b): recreate a database, empty a Redis database, empty a bucket. Each takes the exact
// target it works on and refuses nothing itself: the guards are in db-reset-plan.ts, and the command calls them first.
import { DeleteObjectsCommand, HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import { createPool } from '../../src/infra/db';
import type { ResetTarget } from './db-reset-plan';

/** A database name that may be quoted into SQL as it is. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Checks that the server behind `adminUrl` answers.
 *
 * Why: the command checks every server before it changes anything, so a stopped Redis or Postgres leaves the data as it was.
 *
 * @param adminUrl a connection string of the server (its maintenance database)
 * @throws {Error} when the server cannot be reached or the login fails
 */
export async function pingPostgres(adminUrl: string): Promise<void> {
  const pool = createPool(adminUrl, 1);
  try {
    await pool.query('select 1');
  } finally {
    await pool.end();
  }
}

/**
 * Drops a database, with every connection to it, and creates it again empty.
 *
 * Why: the first step of a fresh start. `WITH (FORCE)` ends the connections of a running API or worker instead of failing
 * because the database is in use.
 *
 * Side effects: `DROP DATABASE` and `CREATE DATABASE` on the server of `adminUrl`; the database's data is gone.
 *
 * @param adminUrl a connection string of the same server on its maintenance database (`postgres`)
 * @param name the database to recreate (letters, digits and underscores)
 * @throws {RangeError} when the name is not a plain identifier
 * @throws {Error} when the login may not drop or create databases
 */
export async function recreateDatabase(adminUrl: string, name: string): Promise<void> {
  if (!SAFE_IDENTIFIER.test(name)) throw new RangeError(`"${name}" is not a plain database name.`);
  const pool = createPool(adminUrl, 1);
  try {
    // Identifiers cannot be bound parameters; the check above leaves nothing to escape.
    await pool.query(`drop database if exists "${name}" with (force)`);
    await pool.query(`create database "${name}"`);
  } finally {
    await pool.end();
  }
}

function redisClient(url: string): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 3_000,
    maxRetriesPerRequest: 1,
    // A script run once: fail at the first refused connection instead of retrying for ever.
    retryStrategy: () => null,
  });
  client.on('error', () => undefined);
  return client;
}

/**
 * Checks that a Redis server answers.
 *
 * @param url the Redis URL
 * @throws {Error} when it cannot be reached
 */
export async function pingRedis(url: string): Promise<void> {
  const client = redisClient(url);
  try {
    await client.connect();
    await client.ping();
  } finally {
    client.disconnect();
  }
}

/**
 * Empties the Redis database the URL names (`FLUSHDB`: only that database, never the others of the server).
 *
 * Why: BullMQ jobs and schedulers hold ids of the rows that were just dropped, and the cache holds their views; both would
 * point at data that no longer exists.
 *
 * Side effects: deletes every key of that database.
 *
 * @param url the Redis URL with its database number (`redis://localhost:6379/0`)
 * @returns how many keys were removed
 */
export async function flushRedisDatabase(url: string): Promise<number> {
  const client = redisClient(url);
  try {
    await client.connect();
    const keys = await client.dbsize();
    await client.flushdb();
    return keys;
  } finally {
    client.disconnect();
  }
}

function s3Client(bucket: ResetTarget['bucket']): S3Client {
  return new S3Client({
    endpoint: bucket.endpoint,
    region: bucket.region,
    forcePathStyle: bucket.forcePathStyle,
    credentials: { accessKeyId: bucket.accessKeyId, secretAccessKey: bucket.secretAccessKey },
    // The same settings as the application's client (src/infra/storage): checksums only where an operation requires them.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
  });
}

/** Whether an error says the bucket does not exist. */
function isMissingBucket(error: unknown): boolean {
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return named.name === 'NotFound' || named.name === 'NoSuchBucket' || named.$metadata?.httpStatusCode === 404;
}

/**
 * Checks that the S3 endpoint answers and says whether the bucket exists.
 *
 * @param bucket the bucket settings
 * @returns true when the bucket exists, false when it does not (there is nothing to empty)
 * @throws {Error} when the endpoint cannot be reached or refuses the credentials
 */
export async function probeBucket(bucket: ResetTarget['bucket']): Promise<boolean> {
  const client = s3Client(bucket);
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket.name }));
    return true;
  } catch (error) {
    if (isMissingBucket(error)) return false;
    throw error;
  } finally {
    client.destroy();
  }
}

/**
 * Deletes every object of the bucket and keeps the bucket.
 *
 * Why: the `files` table of the new database is empty, so the uploaded files of the old data would be orphans.
 *
 * Side effects: deletes objects, a page of up to 1000 at a time; the bucket itself stays.
 *
 * @param bucket the bucket settings
 * @returns how many objects were removed
 * @throws {Error} when the store refuses a delete
 */
export async function emptyBucket(bucket: ResetTarget['bucket']): Promise<number> {
  const client = s3Client(bucket);
  let removed = 0;
  try {
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket.name, ContinuationToken: token }));
      const objects = (page.Contents ?? []).flatMap((object) =>
        object.Key === undefined ? [] : [{ Key: object.Key }],
      );
      if (objects.length > 0) {
        const result = await client.send(
          new DeleteObjectsCommand({ Bucket: bucket.name, Delete: { Objects: objects, Quiet: true } }),
        );
        if (result.Errors && result.Errors.length > 0) {
          throw new Error(
            `The store refused to delete ${result.Errors.length} object(s): ${result.Errors[0]?.Message ?? ''}`,
          );
        }
        removed += objects.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return removed;
  } finally {
    client.destroy();
  }
}
