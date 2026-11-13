import { expect, it } from "vitest";
import { buttonColumn, buttonField, calendarRange, parseCalendarPage, parseGroups, recordName, tableRecords, tableSchema, visualRecord } from "./transactionalVisualQueries";
import type { TransactionalRow } from "./transactionalCollectionModel";

it("requests whole visible weeks at month and year boundaries without UTC shifts",()=>{
  expect(calendarRange("date",new Date(2026,8,23))).toEqual({fieldId:"date",start:"2026-08-30",end:"2026-10-04"});
  expect(calendarRange("date",new Date(2027,0,5))).toEqual({fieldId:"date",start:"2026-12-27",end:"2027-02-07"});
});
it("refuses unsupported or incorrectly filtered authored calendar reads",()=>{
  const range={fieldId:"date",start:"2026-09-01",end:"2026-10-01"},page={rows:[{id:1,version:1,values:{date:"2026-09-30"}}],nextCursor:null};
  expect(()=>parseCalendarPage(page,["date"],range)).toThrow(/does not support/);
  expect(parseCalendarPage({...page,range},["date"],range).rows).toHaveLength(1);
  expect(()=>parseCalendarPage({...page,range,rows:[{id:1,version:1,values:{date:"2026-10-01"}}]},["date"],range)).toThrow(/does not support/);
});
it("rejects incomplete or duplicate group responses and preserves scalar record identities",()=>{
  expect(()=>parseGroups({rows:[],nextCursor:null},"f")).toThrow();
  expect(()=>parseGroups({groupBy:"f",groups:["a","a"],nextGroupCursor:null},"f")).toThrow();
  expect(parseGroups({groupBy:"f",groups:[null,1,"1"],nextGroupCursor:{value:"1"}},"f")).toEqual({values:[null,1,"1"],next:{value:"1"}});
  expect(visualRecord({id:1,version:1,values:{}},[]).id).not.toEqual(visualRecord({id:"1",version:1,values:{}},[]).id);
});
it("keys the table's columns by field id, adds Button fields after them, and keeps each row beside its record",()=>{
  const fields=[{fieldId:"f-name",name:"Name",type:"text" as const,required:true,unique:false},{fieldId:"f-file",name:"Receipt",type:"attachment" as const,required:false,unique:false},
    {fieldId:"f-stage",name:"Stage",type:"select" as const,options:["New"],required:false,unique:false}];
  const schema=tableSchema(fields,["Mark paid"]);
  expect(schema.fields.map(field=>[field.name,field.type])).toEqual([["f-name","text"],["f-file","text"],["f-stage","select"],[buttonColumn("Mark paid"),"button"]]);
  expect(buttonField(buttonColumn("Mark paid"))).toBe("Mark paid");
  const rows:TransactionalRow[]=[{id:1,version:3,values:{"f-name":"Alice","f-hidden":"x"}},{id:"1",version:9,values:{}}];
  const table=tableRecords(rows,fields);
  // A number and a text of the same digits are two records, and a version never enters a record.
  expect(table.records.map(record=>record.id)).toEqual(["1",'"1"']);
  expect(table.rows.get("1")).toBe(rows[0]);expect(table.rows.get('"1"')).toBe(rows[1]);
  expect(JSON.stringify(table.records)).not.toMatch(/version|f-hidden/);
  expect(table.records[0]!.values.map(value=>[value.field,value.value])).toEqual([["f-name","Alice"],["f-file",null],["f-stage",null]]);
});
it("names a record by its first text value, or by its id when it has none",()=>{
  const fields=[{fieldId:"n",name:"Amount",type:"number" as const,required:false,unique:false},{fieldId:"a",name:"Name",type:"text" as const,required:false,unique:false},{fieldId:"b",name:"Note",type:"text" as const,required:false,unique:false}];
  expect(recordName({id:7,version:1,values:{n:5,a:"  ",b:"Second"}},fields)).toBe("Second");
  expect(recordName({id:7,version:1,values:{n:5,a:"First",b:"Second"}},fields)).toBe("First");
  expect(recordName({id:7,version:1,values:{n:5}},fields)).toBe("record 7");
});
