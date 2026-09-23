import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { createOwnerDatasetCopyRegistry, datasetCopyOwnerKey } from "./ownerDatasetCopyRegistry";
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./ownerDatasetCopy", () => ({ createOwnerDatasetCopy: mocks.open }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.clearAllMocks(); });
async function fixture() {
  const rootPath = await mkdtemp(join(tmpdir(), "dohc-copy-registry-")), lifetime = new AbortController();
  const ownerKey = datasetCopyOwnerKey({ serverUrl: "https://account", userId: "owner" }), registry = createOwnerDatasetCopyRegistry();
  cleanups.push(async () => { await registry.closeAll(); await rm(rootPath, { recursive: true, force: true }); });
  await registry.credentialsChanged(ownerKey);
  mocks.open.mockImplementation(async options => {
    await writeFile(join(options.directory,"owned.sqlite"),"copy");
    return { close: vi.fn(async () => {}), assertOwner: options.assertOwner, data: vi.fn((_remote,_source,signal) => ({signal})) };
  });
  const input = {rootPath,lifetime:lifetime.signal,workspaceId:"w",datasetId:"00000000-0000-4000-8000-000000000001",origin:"https://relay",ownerKey,assertOwner(){}};
  return {registry,input,lifetime};
}
it("shares one opening, retains same-owner token refresh, and serializes workspace replacement",async()=>{
  const f=await fixture(); const [first,second]=await Promise.all([f.registry.get(f.input),f.registry.get(f.input)]);
  expect(first).toBe(second);expect(mocks.open).toHaveBeenCalledOnce();
  await f.registry.credentialsChanged(f.input.ownerKey); expect(await f.registry.get(f.input)).toBe(first);
  const closing=deferred<void>();vi.mocked(first.close).mockImplementationOnce(()=>closing.promise);
  f.lifetime.abort();const replacement=f.registry.get({...f.input,lifetime:new AbortController().signal});
  expect(mocks.open).toHaveBeenCalledOnce();closing.resolve();expect(await replacement).not.toBe(first);expect(mocks.open).toHaveBeenCalledTimes(2);
});
it("invalidates access before logout cleanup and removes copies from closed workspaces",async()=>{
  const f=await fixture();const copy=await f.registry.get(f.input);const options=mocks.open.mock.calls[0]![0];
  f.lifetime.abort();await copy.close();
  const removal=f.registry.credentialsChanged(null);expect(()=>options.assertOwner()).toThrow();await removal;
  expect(await readdir(join(f.input.rootPath,".dohc","dataset-copies"))).toEqual([]);
  await expect(f.registry.get({...f.input,lifetime:new AbortController().signal})).rejects.toThrow(/owner changed/);
});
it("changes owner identity only with the account server or user",()=>{
  expect(datasetCopyOwnerKey({serverUrl:"https://account/",userId:"a"})).toBe(datasetCopyOwnerKey({serverUrl:"https://account",userId:"a"}));
  expect(datasetCopyOwnerKey({serverUrl:"https://other",userId:"a"})).not.toBe(datasetCopyOwnerKey({serverUrl:"https://account",userId:"a"}));
});
it("aborts in-flight copy transport before closing its worker",async()=>{
  const f=await fixture(), copy=await f.registry.get(f.input);
  const captured=copy.data({} as never,{} as never,new AbortController().signal) as unknown as {signal:AbortSignal};
  expect(captured.signal.aborted).toBe(false);
  const close=f.registry.credentialsChanged(null);expect(captured.signal.aborted).toBe(true);await close;
});
it("waits for an opening copy to close before the previous account can reopen it",async()=>{
  const f=await fixture(), opening=deferred<{close:()=>Promise<void>}>(), entered=deferred<void>(), close=vi.fn(async()=>{});
  mocks.open.mockImplementationOnce(async()=>{entered.resolve();return opening.promise;});
  const first=f.registry.get(f.input), refused=expect(first).rejects.toThrow(/owner changed|closed/);
  await entered.promise;
  const switching=f.registry.credentialsChanged("other");
  const back=f.registry.credentialsChanged(f.input.ownerKey);
  const reopened=f.registry.get(f.input);
  expect(mocks.open).toHaveBeenCalledOnce();opening.resolve({close});
  await refused;await switching;await back;await reopened;
  expect(close).toHaveBeenCalledOnce();expect(mocks.open).toHaveBeenCalledTimes(2);
});
