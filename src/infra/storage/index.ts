// Public API of the object-storage infrastructure (decision 004): the module, the service and its option types.
export { StorageModule } from './storage.module';
export {
  DEFAULT_MAX_OBJECT_BYTES,
  DEFAULT_PRESIGN_SECONDS,
  HARD_MAX_OBJECT_BYTES,
  MAX_PRESIGN_SECONDS,
  StorageService,
} from './storage.service';
export type {
  ObjectInfo,
  ObjectStream,
  PresignOptions,
  PutOptions,
  StorageBody,
  StoredObject,
} from './storage.service';
export { StorageHealthIndicator } from './storage.health';
export { assertContentType, assertObjectKey, attachmentDisposition } from './storage-names';
