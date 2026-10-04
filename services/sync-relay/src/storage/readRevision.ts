import type {SqliteDb} from "./types";
import {authorityInteger} from "./liveDocumentAuthority";

// SQLite's data_version observes other connections. total_changes covers local
// DML, including rollbacks; schema_version covers local schema changes.
export function captureSqliteReadRevisionMatches(db:SqliteDb):()=>boolean {
  const statement=db.prepare("SELECT data_version,total_changes() AS changes,(SELECT schema_version FROM pragma_schema_version) AS schema_version FROM pragma_data_version");
  const read=()=>{
    const row=statement.get()!;
    return [authorityInteger(row.data_version),authorityInteger(row.changes),authorityInteger(row.schema_version)];
  };
  const before=read();
  return ()=>{const after=read();return before.every((value,index)=>value===after[index]);};
}

export function captureSqliteReadRevision(db:SqliteDb):()=>void {
  const matches=captureSqliteReadRevisionMatches(db);
  return ()=>{if (!matches()) throw new Error("Relay evidence changed during validation.");};
}
