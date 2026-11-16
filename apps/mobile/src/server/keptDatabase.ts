import { Directory, Paths } from "expo-file-system";
import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { prepareKeptFolder } from "../../modules/durable-file";
import {
  CACHE_FILE,
  createCacheStore,
  createKeptStore,
  KEPT_FILE,
  type CacheStore,
  type KeptStore,
  type Row,
  type SqlConnection,
} from "./keptStore";

/** kept.db through expo-sqlite, in the folder the durable-file module prepares (keptStore.ts). Make one per install. */
export function createKeptDatabase(): KeptStore {
  return createKeptStore({
    open: async () => connection(await openDatabaseAsync(KEPT_FILE, {}, await prepareKeptFolder())),
    remove: async () => deleteDatabaseAsync(KEPT_FILE, await prepareKeptFolder()),
  });
}

/** cache.db through expo-sqlite, in Caches, which the system may clear. Make one per install. */
export function createCacheDatabase(): CacheStore {
  const folder = new Directory(Paths.cache, "dohc-cache").uri;
  return createCacheStore({
    open: async () => connection(await openDatabaseAsync(CACHE_FILE, {}, folder)),
    // It rejects when there is no file, which leaves nothing to delete.
    remove: () => deleteDatabaseAsync(CACHE_FILE, folder).catch(() => undefined),
  });
}

const connection = (database: SQLiteDatabase): SqlConnection => ({
  exec: (source) => database.execAsync(source),
  run: async (source, params) => {
    await database.runAsync(source, [...params]);
  },
  all: (source, params) => database.getAllAsync<Row>(source, [...params]),
  close: () => database.closeAsync(),
});
