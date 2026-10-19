import type {StorageContext} from "./context";

const statements = new WeakMap<StorageContext, Map<string, ReturnType<StorageContext["db"]["prepare"]>>>();
export function replicaStatement(storage: StorageContext, sql: string) {
  let cache=statements.get(storage);
  if (!cache) statements.set(storage,cache=new Map());
  let prepared=cache.get(sql);
  if (!prepared) cache.set(sql,prepared=storage.db.prepare(sql));
  return prepared;
}
