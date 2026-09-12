import {afterEach,expect,it,vi} from "vitest";
import {closeTestStorages,request,testHandler,testStorage} from "./testing";

afterEach(closeTestStorages);

it("derives response ownership from explicit bearer credentials and never ambient cookies",async()=>{
  const storage=await testStorage();
  vi.spyOn(storage,"workspaceIsOwnedBy").mockImplementation((workspace,owner)=>workspace==="w" && owner==="owner");
  const read=vi.spyOn(storage,"readOwnerAppCollectionAcceptances").mockReturnValue({acceptances:[],nextAcceptanceId:null});
  const handler=testHandler(storage);
  const path="/sync/w/app-responses/g?limit=7&publicPrincipalId=public-a";
  const response=await handler(request("owner",path));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(read).toHaveBeenCalledWith({workspaceId:"w",ownerUserId:"owner",grantId:"g",publicPrincipalId:"public-a",afterAcceptanceId:undefined,limit:7});
  for(const req of [request(null,path),request("owner",path,{headers:{cookie:"session=owner"}}),request("other",path),request("owner","/sync/elsewhere/app-responses/g")])expect((await handler(req)).status).toBe(404);
  expect(read).toHaveBeenCalledOnce();
});

it("rejects mutation methods and ambiguous queries before reading receipts",async()=>{
  const storage=await testStorage();
  vi.spyOn(storage,"workspaceIsOwnedBy").mockReturnValue(true);
  const read=vi.spyOn(storage,"readOwnerAppCollectionAcceptances");
  const handler=testHandler(storage);
  expect((await handler(request("owner","/sync/w/app-responses/g",{method:"POST"}))).status).toBe(405);
  for(const query of ["limit=1&limit=2","ownerUserId=other"])expect((await handler(request("owner",`/sync/w/app-responses/g?${query}`))).status).toBe(400);
  expect(read).not.toHaveBeenCalled();
  const mismatched=testHandler(storage,{resolveActor:async()=>({workspaceId:"elsewhere",userId:"owner"})});
  expect((await mismatched(request("owner","/sync/w/app-responses/g"))).status).toBe(404);
});
