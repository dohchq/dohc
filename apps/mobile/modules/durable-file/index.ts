import { requireNativeModule } from "expo";

/**
 * Prepares the folder that holds kept.db and returns its path: excluded from backup, and on iOS protected until the
 * phone's first unlock after a restart. Rejects with code `ERR_DURABLE_LOCKED` while that keeps the file closed.
 */
export const prepareKeptFolder = (): Promise<string> =>
  requireNativeModule<{ prepareFolder(): Promise<string> }>("DurableFile").prepareFolder();
