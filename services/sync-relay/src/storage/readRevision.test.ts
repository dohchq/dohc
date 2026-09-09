import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,relative,isAbsolute} from "node:path";
import {expect,it} from "vitest";
import {captureSqliteReadRevision} from "./readRevision";
import type {SqliteDb} from "./types";

function fixture(){
  const root=mkdtempSync(join(tmpdir(),"relay-revision-")),path=join(root,"db.sqlite"),a=new DatabaseSync(path);
  a.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence(bytes BLOB); INSERT INTO evidence VALUES (x'010203')");
  const b=new DatabaseSync(path);
  return {a,b,db:a as unknown as SqliteDb,close(){b.close();a.close();const part=relative(tmpdir(),root);expect(part.startsWith("relay-revision-")&&!part.includes("..")&&!isAbsolute(part)).toBe(true);rmSync(root,{recursive:true,force:true});}};
}
it("keeps a read snapshot stable and rejects an external same-length blob rewrite at writer entry",()=>{
  const f=fixture();
  try {
    f.a.exec("BEGIN");const unchanged=captureSqliteReadRevision(f.db);
    expect(f.a.prepare("SELECT hex(bytes) AS bytes FROM evidence").get()!.bytes).toBe("010203");
    f.b.exec("UPDATE evidence SET bytes=x'040506'");
    unchanged();expect(f.a.prepare("SELECT hex(bytes) AS bytes FROM evidence").get()!.bytes).toBe("010203");
    f.a.exec("COMMIT; BEGIN IMMEDIATE");
    expect(unchanged).toThrow(/changed/);f.a.exec("ROLLBACK");
  }finally{f.close();}
});
it.each(["UPDATE evidence SET bytes=x'040506'","BEGIN; UPDATE evidence SET bytes=x'040506'; ROLLBACK","ALTER TABLE evidence ADD COLUMN tag TEXT"])(
  "rejects same-connection mutations: %s",sql=>{
    const f=fixture();try{const unchanged=captureSqliteReadRevision(f.db);f.a.exec(sql);f.a.exec("BEGIN IMMEDIATE");expect(unchanged).toThrow(/changed/);f.a.exec("ROLLBACK");}finally{f.close();}
  });
it("allows unchanged writer entry and prevents concurrent writes after the check",()=>{
  const f=fixture();try{
    const unchanged=captureSqliteReadRevision(f.db);f.a.exec("BEGIN IMMEDIATE");unchanged();
    expect(()=>f.b.exec("UPDATE evidence SET bytes=x'040506'")).toThrow(/locked/);
    f.a.exec("ROLLBACK");unchanged();
  }finally{f.close();}
});
