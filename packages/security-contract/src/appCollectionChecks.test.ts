import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseAppCollectionCapability, APP_COLLECTION_CURSOR_BYTES, APP_COLLECTION_FIELDS_BYTES, APP_COLLECTION_PAGE_BYTES, APP_COLLECTION_SERVER_FIELDS, type AppCollectionCapability } from "./appCollection";
import { APP_COLLECTION_MAX_RECORD_BYTES, isAppCollectionRecordTooLarge, exposesAppCollectionSubmittedFields, isAppCollectionPageRequest, isAppCollectionRecordPath, narrowsAppCollectionCapability, pageAppCollectionRecords, projectAppCollectionRecord, validateAppCollectionCreateFields, validateAppCollectionSchema } from "./appCollectionChecks";
import { parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";

const capability: AppCollectionCapability = {kind:"collection-create",collectionPath:"responses",schemaSha256:"a".repeat(64),allowedFields:["name","count","tags"],requiredFields:["name"],readFields:["name","count","tags"]};
const schemaText = "fields:\n  name:\n    type: text\n  count:\n    type: number\n  tags:\n    type: multi-select\n    options: [Tokyo, Manila]\n  secret:\n    type: text\n";
const schema = parseCollectionSchema(schemaText).schema;
const encode = (text: string) => new TextEncoder().encode(text);
const document = (fields: unknown, body = "") => encode(`---\n${JSON.stringify(fields)}\n---\n${body}`);
const record = (path: string, name: string) => ({path,recordId:null,fields:{name}});

describe("approval checks", () => {
  it("allows narrowing and additional required fields", () => {
    expect(narrowsAppCollectionCapability(capability,{...capability,allowedFields:["name"],readFields:[],requiredFields:["name"]})).toBe(true);
    expect(narrowsAppCollectionCapability(capability,{...capability,requiredFields:["name","count"]})).toBe(true);
  });
  it.each([
    {collectionPath:"other"}, {schemaSha256:"b".repeat(64)}, {allowedFields:["secret"]}, {readFields:["secret"]}, {requiredFields:[]},
  ])("refuses authority expansion %j", patch => {
    expect(narrowsAppCollectionCapability(capability,{...capability,...patch})).toBe(false);
  });
  it("keeps shared-file disclosure separate from narrowing", () => {
    const narrowed = {...capability,readFields:["name"]};
    expect(narrowsAppCollectionCapability(capability,narrowed)).toBe(true);
    expect(exposesAppCollectionSubmittedFields(narrowed)).toBe(false);
    expect(exposesAppCollectionSubmittedFields(capability)).toBe(true);
  });
  it.each([...APP_COLLECTION_SERVER_FIELDS,"ID","__proto__","prototype","constructor"])("rejects reserved field %s in every capability field set", name => {
    for (const key of ["allowedFields","requiredFields","readFields"]) {
      expect(() => parseAppCollectionCapability({...capability,[key]:[name]})).toThrow("Invalid collection fields.");
    }
  });
});

describe("schema checks", () => {
  it("accepts the declared schema and checks both write and read fields", () => {
    expect(validateAppCollectionSchema(schemaText,capability,"sync service")).toEqual({ok:true,value:schema});
    for (const key of ["allowedFields","readFields"]) {
      expect(validateAppCollectionSchema(schemaText,{...capability,[key]:["missing"]},"sync service")).toEqual({ok:false,message:"Collection schema does not match approval."});
    }
  });
  it.each(["fields: []", "fields:\n  id:\n    type: text\n", "[invalid"])("refuses degraded schemas %s", text => {
    expect(validateAppCollectionSchema(text,capability,"sync service").ok).toBe(false);
  });
  it("preserves version error precedence and reader wording", () => {
    expect(validateAppCollectionSchema("version: 2\n",capability,"sync service")).toEqual({ok:false,message:"responses/collection.yaml uses a newer version. Update the sync service to read this file."});
    expect(validateAppCollectionSchema("version: 2\n",capability,"dohc")).toEqual({ok:false,message:"responses/collection.yaml uses a newer version. Update dohc to read this file."});
    expect(validateAppCollectionSchema("version: bad\n",capability,"sync service")).toEqual({ok:false,message:"responses/collection.yaml has an invalid version. Set version to 1."});
  });
});

describe("create fields", () => {
  it("returns sorted fields without mutating input", () => {
    const input = {tags:["Tokyo","Manila"],name:"Sam",count:2};
    const checked = validateAppCollectionCreateFields(input,capability,schema);
    expect(checked).toEqual({ok:true,value:{count:2,name:"Sam",tags:["Tokyo","Manila"]}});
    if (checked.ok) expect(Object.keys(checked.value)).toEqual(["count","name","tags"]);
    expect(Object.keys(input)).toEqual(["tags","name","count"]);
  });
  it.each([null,[],"text",Object.fromEntries(Array.from({length:33},(_,i)=>[String(i),null]))])("rejects invalid response %j", value => {
    expect(validateAppCollectionCreateFields(value,capability,schema)).toEqual({ok:false,message:"Invalid collection response."});
  });
  it.each([{}, {name:null}, {name:undefined}, {secret:"x"}])("checks required fields first %j", value => {
    expect(validateAppCollectionCreateFields(value,capability,schema)).toEqual({ok:false,message:"Required collection field is missing."});
  });
  it.each(["id","created_at","created_by","grant_id","idempotency_key","acceptance_id","secret"])("rejects unapproved or reserved %s", key => {
    expect(validateAppCollectionCreateFields({name:"Sam",[key]:1},capability,schema)).toEqual({ok:false,message:"Invalid collection response field."});
  });
  it.each([NaN,Infinity,-Infinity,"1",{},[1]])("rejects invalid number %j", count => {
    expect(validateAppCollectionCreateFields({name:"Sam",count},capability,schema)).toEqual({ok:false,message:"Invalid collection response field."});
  });
  it.each([["Tokyo",1],["Tokyo",null],["Tokyo",{}],[["Tokyo"]]])("rejects mixed or nested arrays %j", (...tags) => {
    expect(validateAppCollectionCreateFields({name:"Sam",tags},capability,schema).ok).toBe(false);
  });
  it("rejects non-JSON scalars even when the field type accepts them", () => {
    expect(validateAppCollectionCreateFields({name:"Sam",count:1n},capability,schema)).toEqual({ok:false,message:"Invalid collection response value."});
    expect(validateAppCollectionCreateFields({name:"Sam",count:undefined},capability,schema)).toEqual({ok:false,message:"Invalid collection response value."});
    expect(validateAppCollectionCreateFields({name:"Sam",count:null,tags:[]},capability,schema).ok).toBe(true);
  });
  it("accepts 32 fields and rejects 33", () => {
    const names = Array.from({length:32},(_,i)=>`field${i}`);
    const cap = {...capability,allowedFields:names,requiredFields:[]};
    const typed = {...schema,fields:names.map(name=>({name,type:"text" as const}))};
    expect(validateAppCollectionCreateFields(Object.fromEntries(names.map(name=>[name,"x"])),cap,typed).ok).toBe(true);
    expect(validateAppCollectionCreateFields(Object.fromEntries([...names,"extra"].map(name=>[name,"x"])),cap,typed)).toEqual({ok:false,message:"Invalid collection response."});
  });
  it("counts UTF-8 JSON bytes at and above the field cap", () => {
    const overhead = encode(JSON.stringify({name:""})).byteLength;
    const name = "é".repeat(Math.floor((APP_COLLECTION_FIELDS_BYTES-overhead)/2))+"x".repeat((APP_COLLECTION_FIELDS_BYTES-overhead)%2);
    expect(encode(JSON.stringify({name}))).toHaveLength(APP_COLLECTION_FIELDS_BYTES);
    expect(validateAppCollectionCreateFields({name},capability,schema).ok).toBe(true);
    expect(validateAppCollectionCreateFields({name:name+"x"},capability,schema)).toEqual({ok:false,message:"Collection response is too large."});
  });
});

describe("page requests and read paths", () => {
  it("checks page limits and cursor bytes without adding HTTP path validation", () => {
    for (const limit of [1,100]) expect(isAppCollectionPageRequest(limit,undefined)).toBe(true);
    for (const limit of [0,101,1.5,NaN,"1"]) expect(isAppCollectionPageRequest(limit,undefined)).toBe(false);
    expect(isAppCollectionPageRequest(1,"é".repeat(APP_COLLECTION_CURSOR_BYTES/2))).toBe(true);
    expect(isAppCollectionPageRequest(1,"é".repeat(APP_COLLECTION_CURSOR_BYTES/2)+"x")).toBe(false);
    expect(isAppCollectionPageRequest(1,null)).toBe(false);
    expect(isAppCollectionPageRequest(1,"")).toBe(true);
  });
  it("matches SQLite direct-child, extension and byte filtering", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const prefix = "responses/";
      const atCap = prefix+"é".repeat((APP_COLLECTION_CURSOR_BYTES-prefix.length-3)/2)+"x.md";
      const paths = ["responses/a.md","responses/a.MD","responses/a.md\n","responses/.md","responses/nested/a.md","responses/a.txt","responses2/a.md",atCap,atCap+"x",prefix+"x".repeat(APP_COLLECTION_CURSOR_BYTES)+".md"];
      const query = db.prepare(`SELECT ? AS path WHERE path>=? AND path<? AND length(CAST(path AS BLOB))<=${APP_COLLECTION_CURSOR_BYTES} AND instr(substr(path,length(?)+1),'/')=0 AND path LIKE '%.md'`);
      for (const path of paths) expect(isAppCollectionRecordPath("responses",path),path).toBe(!!query.get(path,prefix,"responses0",prefix));
      expect(encode(atCap)).toHaveLength(APP_COLLECTION_CURSOR_BYTES);
      expect(isAppCollectionRecordPath("responses",atCap)).toBe(true);
      expect(isAppCollectionRecordPath("responses",atCap.slice(0,-3)+"x.md")).toBe(false);
    } finally {db.close();}
  });
});

describe("read projection", () => {
  it("projects only approved fields in approval order and preserves the record ID", () => {
    const id = "rec_"+"a".repeat(26);
    expect(projectAppCollectionRecord("responses/a.md",document({id,name:"Sam",count:2,secret:"private",created_by:"owner"}),capability,schema)).toEqual({path:"responses/a.md",recordId:id,fields:{name:"Sam",count:2}});
    expect(projectAppCollectionRecord("responses/a.md",document({id:"invalid",name:"Sam"}),capability,schema)?.recordId).toBeNull();
  });
  it.each([{secret:"x"},{name:1},{name:"Sam",tags:["Tokyo",1]},{name:"Sam",tags:[["Tokyo"]]}])("skips empty or invalid projections %j", fields => {
    expect(projectAppCollectionRecord("responses/a.md",document(fields),capability,schema)).toBeNull();
  });
  it("skips invalid UTF-8, missing frontmatter and empty read fields", () => {
    for (const blob of [new Uint8Array([255]),encode("body only")]) expect(projectAppCollectionRecord("responses/a.md",blob,capability,schema)).toBeNull();
    expect(projectAppCollectionRecord("responses/a.md",document({name:"Sam"}),{...capability,readFields:[]},schema)).toBeNull();
  });
  it("counts the complete record at and over the byte cap", () => {
    const blob = document({name:"Sam"});
    const atCap = document({name:"Sam"},"x".repeat(APP_COLLECTION_MAX_RECORD_BYTES-blob.byteLength));
    expect(isAppCollectionRecordTooLarge(atCap.byteLength)).toBe(false);
    expect(projectAppCollectionRecord("responses/a.md",atCap,capability,schema)).not.toBeNull();
    expect(isAppCollectionRecordTooLarge(atCap.byteLength+1)).toBe(true);
    expect(projectAppCollectionRecord("responses/a.md",document({name:"Sam"},"x".repeat(APP_COLLECTION_MAX_RECORD_BYTES-blob.byteLength+1)),capability,schema)).toBeNull();
  });
});

describe("paging already ordered rows", () => {
  const row = (path: string, name: string) => ({path,record:record(path,name)});
  it("preserves input order and returns the last scanned path only with more rows", () => {
    const rows = [row("responses/😀.md","A"),row("responses/\ue000.md","B"),{path:"responses/skipped.md",record:null}];
    expect(pageAppCollectionRecords(rows,false)).toEqual({records:rows.slice(0,2).map(row=>row.record),nextPath:null});
    expect(pageAppCollectionRecords(rows,true).nextPath).toBe("responses/skipped.md");
    expect(pageAppCollectionRecords([],true)).toEqual({records:[],nextPath:null});
  });
  it("includes exactly the page byte cap and skips a single oversized record", () => {
    const overhead = encode(JSON.stringify(record("a",""))).byteLength;
    const exact = row("a","x".repeat(APP_COLLECTION_PAGE_BYTES-overhead));
    expect(pageAppCollectionRecords([exact],false)).toEqual({records:[exact.record],nextPath:null});
    expect(pageAppCollectionRecords([row("a",exact.record.fields.name+"x")],true)).toEqual({records:[],nextPath:"a"});
  });
  it("returns the previous scanned cursor on overflow without consuming later rows", () => {
    function* rows() {
      yield row("a","x".repeat(APP_COLLECTION_PAGE_BYTES/2));
      yield {path:"b",record:null};
      yield row("c","x".repeat(APP_COLLECTION_PAGE_BYTES/2));
      throw new Error("must not inspect rows after overflow");
    }
    const page = pageAppCollectionRecords(rows(),false);
    expect(page.records).toHaveLength(1);
    expect(page.nextPath).toBe("b");
  });
});
