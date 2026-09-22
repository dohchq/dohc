import { expect, it } from "vitest";
import { calendarRange, parseCalendarPage, parseGroups, visualRecord } from "./transactionalVisualQueries";

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
