import type { DatasetDefinition } from "@dohc/security-contract/dataset";

const id = (n: number) => `b0010000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const loadDefinition: DatasetDefinition = {
  formatVersion: 1, datasetId: id(1), name: "Load proof requests", schemaPath: "fundraiser/schema.sql", operationsPath: "fundraiser/backend.ts",
  tables: [{tableId: id(2), name: "Requests", sqlName: "requests", primaryKey: "id", fields: [
    {fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true},
    {fieldId: id(4), name: "Receipt", sqlColumn: "receipt", type: "attachment", required: true, unique: false},
  ]}], operations: [
    {operationId: id(5), name: "availability", label: "Availability", tableId: id(2), kind: "read", access: "link", readOnly: true, fieldIds: []},
    {operationId: id(6), name: "submit", label: "Submit", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [id(4)]},
    {operationId: id(7), name: "status", label: "Status", tableId: id(2), kind: "read", access: "link", readOnly: true, fieldIds: [id(3)]},
    {operationId: id(8), name: "list", label: "List", tableId: id(2), kind: "read", access: "helper", readOnly: true, fieldIds: [id(3), id(4)]},
  ],
};
export const loadSchema = "CREATE TABLE requests(id TEXT PRIMARY KEY NOT NULL,receipt TEXT NOT NULL,token TEXT NOT NULL UNIQUE);";
export const loadOperations = `globalThis.operations={
  availability(){return {available:true};},
  submit(ctx,input){ctx.files.attach(input.fileId);ctx.db.execute('INSERT INTO requests VALUES(?,?,?)',[ctx.requestId,input.fileId,ctx.secret]);return {id:ctx.requestId,statusToken:ctx.secret};},
  status(ctx,input){const row=ctx.db.query('SELECT id FROM requests WHERE token=?',[input.token])[0];if(!row)ctx.refuse('not_found','No request has this status token.');return row;},
  list(ctx){return ctx.db.query('SELECT id,receipt FROM requests ORDER BY id LIMIT 101');}
};`;

// Test-only source: it uses the same sandbox channel as a user-authored app.
export const loadFrontend = `
let port;const pending=new Map();
globalThis.loadRequest=body=>new Promise((resolve,reject)=>{
  const id=crypto.randomUUID();const timer=setTimeout(()=>{pending.delete(id);reject(Error('Broker deadline exceeded'));},30000);
  pending.set(id,value=>{clearTimeout(timer);resolve(value);});port.postMessage({...body,id});
});
addEventListener('message',event=>{
  if(port||event.source!==parent||event.data?.kind!=='dohc-app-channel'||event.ports.length!==1)return;
  port=event.ports[0];port.onmessage=event=>{pending.get(event.data.id)?.(event.data);pending.delete(event.data.id);};
  port.start();document.body.dataset.ready='true';
});
`;
