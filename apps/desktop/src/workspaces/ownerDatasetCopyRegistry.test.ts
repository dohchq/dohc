import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { fakeLocalStateOpens, openedLocalState } from "../testing/preparedLocalState";
import { createOwnerDatasetCopyRegistry, datasetCopyOwnerKey } from "./ownerDatasetCopyRegistry";
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./ownerDatasetCopy", () => ({ createOwnerDatasetCopy: mocks.open }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.clearAllMocks(); });
async function fixture({ opened = true } = {}) {
  const rootPath = await mkdtemp(join(tmpdir(), "dohc-copy-registry-")), lifetime = new AbortController();
  if (opened) await openedLocalState({ workspaceId: "w", rootPath });
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
  expect(await readdir(join(f.input.rootPath,".dohc","local","dataset-copies"))).toEqual([]);
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

it("keeps each copy in .dohc/local/dataset-copies, private, and ignores the old folder",async()=>{
  const f=await fixture();
  const old=join(f.input.rootPath,".dohc","dataset-copies");await mkdir(old,{recursive:true});await writeFile(join(old,"replica.sqlite"),"old");
  await f.registry.get(f.input);
  const {directory}=mocks.open.mock.calls[0]![0];
  expect(dirname(directory)).toBe(join(f.input.rootPath,".dohc","local","dataset-copies"));
  for(const folder of [dirname(directory),directory])expect((await lstat(folder)).mode&0o777).toBe(0o700);
  expect(await readdir(old)).toEqual(["replica.sqlite"]);expect(await readFile(join(old,"replica.sqlite"),"utf8")).toBe("old");
  // Signing out removes the copy at its new path, and the old folder with the account's data.
  await f.registry.credentialsChanged(null);
  expect(await readdir(dirname(directory))).toEqual([]);
  expect(await readdir(join(f.input.rootPath,".dohc"))).toEqual(["local"]);
});
it("removes old offline copies in .dohc/dataset-copies when the account changes",async()=>{
  const f=await fixture(),old=join(f.input.rootPath,".dohc","dataset-copies","0".repeat(64));
  await mkdir(old,{recursive:true});await writeFile(join(old,"replica.sqlite"),"account data");await writeFile(join(old,"archived.json"),"{}");
  await f.registry.get(f.input);
  await f.registry.credentialsChanged("other");
  expect(await readdir(join(f.input.rootPath,".dohc"))).toEqual(["local"]);
});
it.skipIf(process.platform==="win32")("does not follow a link at .dohc/dataset-copies when the account changes",async()=>{
  const f=await fixture(),outside=await mkdtemp(join(tmpdir(),"dohc-copy-registry-outside-"));
  cleanups.push(()=>rm(outside,{recursive:true,force:true}));
  await writeFile(join(outside,"keep.txt"),"not dohc's");
  await symlink(outside,join(f.input.rootPath,".dohc","dataset-copies"),"dir");
  await f.registry.get(f.input);
  await f.registry.credentialsChanged(null);
  expect(await readFile(join(outside,"keep.txt"),"utf8")).toBe("not dohc's");
  expect((await lstat(join(f.input.rootPath,".dohc","dataset-copies"))).isSymbolicLink()).toBe(true);
});
it("closes a copy that opened on a retry before it removes the folder the failed attempt shared",async()=>{
  const f=await fixture(),closing=deferred<void>();
  mocks.open.mockImplementationOnce(async()=>{throw new Error("The Collection copy is damaged. Download it again.");});
  await expect(f.registry.get(f.input)).rejects.toThrow("damaged");
  const copy=await f.registry.get(f.input);const {directory}=mocks.open.mock.calls[1]![0];
  vi.mocked(copy.close).mockImplementationOnce(()=>closing.promise);
  const removal=f.registry.credentialsChanged(null);
  // Time for a removal that did not wait for the close to finish; the folder must still be there.
  await new Promise<void>(resolve=>setTimeout(resolve,50));
  expect(await readdir(directory)).toEqual(["owned.sqlite"]);
  closing.resolve();await removal;
  expect(await readdir(dirname(directory))).toEqual([]);
});
it.each([["not opened",false,"the workspace has not finished opening. Try again when it opens."],
  ["not kept out of iCloud Drive",true,"it can't keep this workspace's .dohc/local out of iCloud Drive. Restart dohc to try again."]] as const)(
  "makes no copy and creates nothing while .dohc/local is %s, then opens one once it is ready",async(_state,opened,why)=>{
  const f=await fixture({opened:false}),workspace={workspaceId:"w",rootPath:f.input.rootPath},opens=fakeLocalStateOpens();
  if(opened){await opens.open(workspace,false);await rm(join(f.input.rootPath,".dohc","local"),{recursive:true});}
  await expect(f.registry.get(f.input)).rejects.toThrow(`dohc did not open this Collection's offline copy because ${why}`);
  expect(mocks.open).not.toHaveBeenCalled();
  expect(await readdir(f.input.rootPath)).toEqual(opened?[".dohc"]:[]);
  if(opened)expect(await readdir(join(f.input.rootPath,".dohc"))).toEqual([]);
  // The refused request leaves nothing behind that keeps the next one from opening.
  await opens.open(workspace);
  await f.registry.get(f.input);expect(mocks.open).toHaveBeenCalledOnce();
});
it.skipIf(process.platform==="win32").each(["writable by others","hard-linked"])("does not open a replica database that is %s",async kind=>{
  const f=await fixture(),first=new AbortController();
  const copy=await f.registry.get({...f.input,lifetime:first.signal});const {directory}=mocks.open.mock.calls[0]![0];
  first.abort();await copy.close();
  const planted=join(directory,"replica.sqlite");await writeFile(planted,"planted");
  if(kind==="writable by others")await chmod(planted,0o666);else await link(planted,join(f.input.rootPath,"elsewhere.sqlite"));
  await expect(f.registry.get(f.input)).rejects.toThrow(`dohc did not open this Collection's offline copy because it can't trust a file in .dohc/local/dataset-copies/${basename(directory)}. Remove that folder, then try again.`);
  expect(mocks.open).toHaveBeenCalledOnce();expect(await readFile(planted,"utf8")).toBe("planted");
  // Once the folder is gone, the next request opens a copy.
  await rm(directory,{recursive:true});await f.registry.get(f.input);expect(mocks.open).toHaveBeenCalledTimes(2);
});
it("removes a copy that did not open when the account changes",async()=>{
  const f=await fixture();
  mocks.open.mockImplementationOnce(async options=>{await writeFile(join(options.directory,"replica.sqlite"),"downloaded");throw new Error("The Collection copy is damaged. Download it again.");});
  await expect(f.registry.get(f.input)).rejects.toThrow("damaged");
  const copies=join(f.input.rootPath,".dohc","local","dataset-copies");expect(await readdir(copies)).toHaveLength(1);
  await f.registry.credentialsChanged(null);
  expect(await readdir(copies)).toEqual([]);
});
