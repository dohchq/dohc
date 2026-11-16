import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { prepareKeptFolder } from "../../modules/durable-file";
import {
  createKeptStore,
  KEPT_FILE,
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

const connection = (database: SQLiteDatabase): SqlConnection => ({
  exec: (source) => database.execAsync(source),
  run: async (source, params) => {
    await database.runAsync(source, [...params]);
  },
  all: (source, params) => database.getAllAsync<Row>(source, [...params]),
  close: () => database.closeAsync(),
});
