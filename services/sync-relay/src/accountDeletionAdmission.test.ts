import type {Pool} from "pg";
import {afterEach, expect, it} from "vitest";
import {createAccountDeletionRoute, fencePendingAccountDeletions} from "./accountDeletionRoute";
import {closeTestStorages, request, resolveTestActor, testHandler, testStorage} from "./testing";
import type {StorageContext} from "./storage/context";
import {accountIsFenced} from "./storage/accountDeletion";
afterEach(closeTestStorages);
it("loads pending jobs once before serving and fences only their accounts",async()=>{
  let reads=0;
  const pool={async query(){reads++;return {rows:[{user_id:"deleted",email:"deleted@example.test"}]};}} as unknown as Pool;
  const storage=await testStorage() as StorageContext;
  storage.claimWorkspace({workspaceId:"owned",ownerUserId:"deleted",createdAtMs:1});
  storage.claimWorkspace({workspaceId:"survivor",ownerUserId:"other",createdAtMs:1});
  const deletion=createAccountDeletionRoute({storage,key:"bearer-test",fenceKey:"fence-test",invalidate(){},deleteRuntime:async()=>{}});
  expect(await fencePendingAccountDeletions(pool,deletion)).toHaveLength(1);
  expect(reads).toBe(1);
  expect(accountIsFenced(storage,"deleted")).toBe(true);
  expect(storage.workspaceIsOwnedBy("owned","deleted")).toBe(false);
  expect(storage.workspaceIsOwnedBy("survivor","other")).toBe(true);
  await deletion.purge("deleted","deleted@example.test");
  expect(reads).toBe(1);
});

it.each(["synchronous", "asynchronous"] as const)("refuses fenced accounts with %s actor resolution", async mode => {
  const storage = await testStorage() as StorageContext;
  const deletion = createAccountDeletionRoute({storage, key: "bearer-test", fenceKey: "fence-test", invalidate() {}, deleteRuntime: async () => {}});
  const handler = testHandler(storage, {
    resolveActor: mode === "synchronous" ? resolveTestActor : async (request, workspaceId) => resolveTestActor(request, workspaceId),
  });
  expect((await handler(request("deleted", "/sync/shares"))).status).toBe(200);
  deletion.fence("deleted", "deleted@example.test");
  expect((await handler(request("deleted", "/sync/shares"))).status).toBe(404);
  expect((await handler(request("other", "/sync/shares"))).status).toBe(200);
});

it("checks the fence after pending actor resolution completes", async () => {
  const storage = await testStorage() as StorageContext;
  const deletion = createAccountDeletionRoute({storage, key: "bearer-test", fenceKey: "fence-test", invalidate() {}, deleteRuntime: async () => {}});
  let releaseActor!: (actor: ReturnType<typeof resolveTestActor>) => void;
  const pendingActor = new Promise<ReturnType<typeof resolveTestActor>>(resolve => {releaseActor = resolve;});
  let signalStarted!: () => void;
  const started = new Promise<void>(resolve => {signalStarted = resolve;});
  const handler = testHandler(storage, {
    resolveActor: () => {
      signalStarted();
      return pendingActor;
    },
  });
  const pending = handler(request("deleted", "/sync/shares"));
  await started;
  deletion.fence("deleted", "deleted@example.test");
  releaseActor({userId: "deleted", workspaceId: ""});
  expect((await pending).status).toBe(404);
});
