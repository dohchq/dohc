// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {PublishedApps} from "./PublishedApps";
import {jsonResponse,heldJsonResponse,settle} from "./testing";
let container:HTMLDivElement,root:Root;
beforeEach(()=>{container=document.createElement("div");document.body.append(container);root=createRoot(container);Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
const render=(session="abcdefghijkl")=>act(async()=>root.render(<PublishedApps session={session}/>));
const row=(id:string,name:string)=>({publicationId:id.repeat(64),name});
it("loads named apps with launch controls and follows a bounded cursor",async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(jsonResponse({publications:[row("a","Trip poll")],nextCursor:"b".repeat(64)})).mockResolvedValueOnce(jsonResponse({publications:[row("c","Packing list")],nextCursor:null}));vi.stubGlobal("fetch",fetch);
  await render();await settle(()=>container.textContent!.includes("Trip poll"));
  const more=[...container.querySelectorAll("button")].find(b=>b.textContent==="Load more apps")!;await act(async()=>more.click());await settle(()=>container.textContent!.includes("Packing list"));
  expect(fetch.mock.calls[1]![0]).toContain("cursor="+"b".repeat(64));expect([...container.querySelectorAll("button")].filter(b=>b.textContent==="Open app")).toHaveLength(2);
});
it("shows retry after a failure and does not paint a previous link's delayed apps",async()=>{
  const held=heldJsonResponse(200),fetch=vi.fn().mockResolvedValueOnce(held.response).mockResolvedValueOnce(jsonResponse({},503)).mockResolvedValueOnce(jsonResponse({publications:[],nextCursor:null}));vi.stubGlobal("fetch",fetch);
  await render();await settle(held.bodyStarted);await render("mnopqrstuvwx");await settle(()=>container.textContent!.includes("Could not load apps"));
  await act(async()=>held.release({publications:[row("a","Private old app")],nextCursor:null}));expect(container.textContent).not.toContain("Private old app");
  await act(async()=>[...container.querySelectorAll("button")].find(b=>b.textContent==="Retry")!.click());await settle(()=>container.textContent!.includes("No apps are available"));
});
