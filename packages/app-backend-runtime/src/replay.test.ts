import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { replayThroughShadow } from "./replay.ts";

it("rolls back canonical rows and cursor when the recovery commit fails",()=>{
  const directory=mkdtempSync(join(tmpdir(),"dohc-replay-fault-"));
  const source=new DatabaseSync(":memory:"),target=new DatabaseSync(":memory:");
  try {
    const schema="CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT UNIQUE); INSERT INTO items VALUES(1,'a'),(2,'b');";
    source.exec(schema);target.exec(schema+"CREATE TABLE cursor(revision INTEGER); INSERT INTO cursor VALUES(0)");
    const session=source.createSession();
    try {
      source.exec("UPDATE items SET value='temp' WHERE id=1; UPDATE items SET value='a' WHERE id=2; UPDATE items SET value='b' WHERE id=1;");
      expect(()=>replayThroughShadow(target,{directory,tables:["items"],changeset:session.changeset(),databaseBytes:16*1024*1024},()=>{
        target.exec("UPDATE cursor SET revision=1");throw Error("commit failed");
      })).toThrow("commit failed");
    }finally{session.close();}
    expect(target.prepare("SELECT * FROM items ORDER BY id").all()).toEqual([{id:1,value:"a"},{id:2,value:"b"}]);
    expect(target.prepare("SELECT revision FROM cursor").get()?.revision).toBe(0);
    expect(readdirSync(directory)).toEqual([]);
  }finally{source.close();target.close();rmSync(directory,{recursive:true,force:true});}
});

it("keeps canonical constraints when a changeset's final rows are invalid",()=>{
  const directory=mkdtempSync(join(tmpdir(),"dohc-replay-invalid-"));
  const source=new DatabaseSync(":memory:"),target=new DatabaseSync(":memory:");
  try {
    source.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO items VALUES(1,'a'),(2,'b')");
    target.exec("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT UNIQUE); INSERT INTO items VALUES(1,'a'),(2,'b')");
    const session=source.createSession();
    try {
      source.exec("UPDATE items SET value='a' WHERE id=2");
      expect(()=>replayThroughShadow(target,{directory,tables:["items"],changeset:session.changeset(),databaseBytes:16*1024*1024},()=>{})).toThrow();
    }finally{session.close();}
    expect(target.prepare("SELECT * FROM items ORDER BY id").all()).toEqual([{id:1,value:"a"},{id:2,value:"b"}]);
    expect(readdirSync(directory)).toEqual([]);
  }finally{source.close();target.close();rmSync(directory,{recursive:true,force:true});}
});

it("restores accepted CHECK decisions without reevaluating them and reenables checks afterward",()=>{
  const directory=mkdtempSync(join(tmpdir(),"dohc-replay-check-"));
  const source=new DatabaseSync(":memory:"),target=new DatabaseSync(":memory:");
  let allowed=true;
  try {
    source.function("accepted",()=>1);target.function("accepted",()=>allowed?1:0);
    const schema="CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT UNIQUE CHECK(accepted())); INSERT INTO items VALUES(1,'a'),(2,'b');";
    source.exec(schema);target.exec(schema);
    const session=source.createSession();
    try {
      source.exec("UPDATE items SET value='temp' WHERE id=1; UPDATE items SET value='a' WHERE id=2; UPDATE items SET value='b' WHERE id=1;");
      allowed=false;
      replayThroughShadow(target,{directory,tables:["items"],changeset:session.changeset(),databaseBytes:16*1024*1024},()=>{});
      expect(target.prepare("SELECT * FROM items ORDER BY id").all()).toEqual([{id:1,value:"b"},{id:2,value:"a"}]);
      expect(()=>target.exec("INSERT INTO items VALUES(3,'c')")).toThrow("CHECK");
    }finally{session.close();}
  }finally{source.close();target.close();rmSync(directory,{recursive:true,force:true});}
});

it("reports its step while it copies and rebuilds rows, so the host sees progress",()=>{
  const directory=mkdtempSync(join(tmpdir(),"dohc-replay-heartbeat-"));
  const source=new DatabaseSync(":memory:"),target=new DatabaseSync(":memory:");
  try {
    const schema="CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT UNIQUE); INSERT INTO items SELECT x,'v'||x FROM (WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2500) SELECT x FROM n);";
    source.exec(schema);target.exec(schema);
    const session=source.createSession(),steps:string[]=[];
    try {
      source.exec("UPDATE items SET value='temp' WHERE id=1; UPDATE items SET value='v1' WHERE id=2; UPDATE items SET value='v2' WHERE id=1;");
      replayThroughShadow(target,{directory,tables:["items"],changeset:session.changeset(),databaseBytes:16*1024*1024},()=>{},{progress:step=>steps.push(step),datasetCheck:(_bytes,run)=>run()});
    }finally{session.close();}
    // 2,500 rows report each phase again after rows 1,000 and 2,000.
    expect(steps.filter(step=>step==="copying the dataset for the replay")).toHaveLength(3);
    expect(steps.filter(step=>step==="rebuilding the dataset from the replay copy")).toHaveLength(3);
  }finally{source.close();target.close();rmSync(directory,{recursive:true,force:true});}
});
