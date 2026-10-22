import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "../testing/deferred";
import { fakeLocalStateOpens, openedLocalState } from "../testing/preparedLocalState";
import { createOwnerDatasetCopyRegistry, datasetCopyOwnerKey } from "./ownerDatasetCopyRegistry";
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./ownerDatasetCopy", () => ({ createOwnerDatasetCopy: mocks.open }));
// The registry's own file calls: how many are running, which folders it
// removed, and the folders whose removal fails as a busy folder's would,
// once its gate opens. A busy removal waiting at its gate is blocked.
const files = vi.hoisted(() => ({ running: 0, removed: [] as string[], busy: new Set<string>(), gates: new Map<string, Promise<void>>(), blocked: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  async function counted<T>(work: Promise<T>): Promise<T> {
    files.running++;
    try { return await work; } finally { files.running--; }
  }
  return { ...actual,
    lstat: ((...args: Parameters<typeof actual.lstat>) => counted(actual.lstat(...args))) as typeof actual.lstat,
    realpath: ((...args: Parameters<typeof actual.realpath>) => counted(actual.realpath(...args))) as typeof actual.realpath,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (files.busy.has(String(args[0]))) {
        files.blocked.push(String(args[0])); await files.gates.get(String(args[0]));
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${String(args[0])}'`), { code: "EBUSY" });
      }
      await counted(actual.rm(...args)); files.removed.push(String(args[0]));
    } };
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { files.busy.clear(); files.gates.clear(); files.blocked.length = 0; for (const close of cleanups.splice(0).reverse()) await close(); vi.clearAllMocks(); });
// The next start of dohc, with the same record.
function restart(record: string, workspaces: string[] = [], onLeftover = vi.fn()) {
  const registry = createOwnerDatasetCopyRegistry({ record, workspaces: () => workspaces, onLeftover });
  cleanups.push(() => registry.closeAll());
  return registry;
}
async function fixture({ opened = true, workspaces = (rootPath: string) => [rootPath] } = {}) {
  const rootPath = await mkdtemp(join(tmpdir(), "dohc-copy-registry-")), lifetime = new AbortController();
  if (opened) await openedLocalState({ workspaceId: "w", rootPath });
  const state = await mkdtemp(join(tmpdir(), "dohc-copy-registry-state-")), record = join(state, "dataset-copy-removals.json"), onLeftover = vi.fn();
  const ownerKey = datasetCopyOwnerKey({ serverUrl: "https://account", userId: "owner" });
  const registry = createOwnerDatasetCopyRegistry({ record, workspaces: () => workspaces(rootPath), onLeftover });
  cleanups.push(async () => { await registry.closeAll(); await rm(rootPath, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); });
  await registry.credentialsChanged(ownerKey);
  mocks.open.mockImplementation(async options => {
    await writeFile(join(options.directory,"owned.sqlite"),"copy");
    return { close: vi.fn(async () => {}), assertOwner: options.assertOwner, data: vi.fn((_remote,_source,signal) => ({signal})) };
  });
  const input = {rootPath,lifetime:lifetime.signal,workspaceId:"w",datasetId:"00000000-0000-4000-8000-000000000001",origin:"https://relay",ownerKey,assertOwner(){}};
  return {registry,input,lifetime,record,onLeftover};
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
  // Windows keeps no POSIX mode bits, so Node reports 0o666 there.
  if(process.platform!=="win32")for(const folder of [dirname(directory),directory])expect((await lstat(folder)).mode&0o777).toBe(0o700);
  expect(await readdir(old)).toEqual(["replica.sqlite"]);expect(await readFile(join(old,"replica.sqlite"),"utf8")).toBe("old");
  // The Collections this computer keeps sit beside the copies, and stay.
  const store=join(f.input.rootPath,".dohc","local","datasets");await mkdir(store);await writeFile(join(store,"state.sqlite"),"the Collections");
  const removedBefore=files.removed.length;
  // Signing out removes the copy at its new path, and the old folder with the account's data.
  await f.registry.credentialsChanged(null);
  expect(await readdir(dirname(directory))).toEqual([]);
  expect(await readdir(join(f.input.rootPath,".dohc"))).toEqual(["local"]);
  expect(await readFile(join(store,"state.sqlite"),"utf8")).toBe("the Collections");
  expect(files.removed.slice(removedBefore).filter(path=>!path.startsWith(dirname(directory))&&!path.startsWith(old))).toEqual([]);
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
  const f=await fixture(),closing=deferred<void>(),closeCalled=deferred<void>();
  mocks.open.mockImplementationOnce(async()=>{throw new Error("The Collection copy is damaged. Download it again.");});
  await expect(f.registry.get(f.input)).rejects.toThrow("damaged");
  const copy=await f.registry.get(f.input);const {directory}=mocks.open.mock.calls[1]![0];
  vi.mocked(copy.close).mockImplementationOnce(()=>{closeCalled.resolve();return closing.promise;});
  files.removed.length=0;
  const removal=f.registry.credentialsChanged(null);
  try {
    await closeCalled.promise;
    // Let what the account change queued start, then wait until no file call of
    // it is running: all it can do before the close finishes has happened.
    await new Promise<void>(resolve=>setImmediate(resolve));
    await vi.waitFor(()=>expect(files.running).toBe(0));
    expect(await readdir(directory)).toEqual(["owned.sqlite"]);expect(files.removed).toEqual([]);
  } finally { closing.resolve(); }
  await removal;
  expect(await readdir(dirname(directory))).toEqual([]);
  expect(files.removed.filter(path=>path===directory)).toHaveLength(1);
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

it("removes old copies even when a copy's own folder can't be removed",async()=>{
  const f=await fixture(),old=join(f.input.rootPath,".dohc","dataset-copies","0".repeat(64));
  await mkdir(old,{recursive:true});await writeFile(join(old,"replica.sqlite"),"account data");
  await f.registry.get(f.input);const {directory}=mocks.open.mock.calls[0]![0];
  const outside=await mkdtemp(join(tmpdir(),"dohc-copy-registry-outside-"));cleanups.push(()=>rm(outside,{recursive:true,force:true}));
  await rm(directory,{recursive:true});await symlink(outside,directory,"dir");
  await expect(f.registry.credentialsChanged(null)).rejects.toThrow("Collection copy storage changed. Its files were not removed.");
  expect(await readdir(join(f.input.rootPath,".dohc"))).toEqual(["local"]);
  // Quitting still closes the copies.
  await f.registry.closeAll();
});
it("removes old copies in a workspace whose copy never opened",async()=>{
  const f=await fixture({opened:false});fakeLocalStateOpens();
  const old=join(f.input.rootPath,".dohc","dataset-copies","0".repeat(64));
  await mkdir(old,{recursive:true});await writeFile(join(old,"replica.sqlite"),"account data");
  for(let attempt=0;attempt<2;attempt++)await expect(f.registry.get(f.input)).rejects.toThrow("the workspace has not finished opening");
  expect(mocks.open).not.toHaveBeenCalled();
  await f.registry.credentialsChanged(null);
  expect(await readdir(join(f.input.rootPath,".dohc"))).toEqual([]);
});

it("still raises at quit a copy an account change could not close, beside a folder it could not remove",async()=>{
  const f=await fixture(),other={...f.input,datasetId:"00000000-0000-4000-8000-000000000002"};
  const stuck=await f.registry.get(f.input);vi.mocked(stuck.close).mockRejectedValueOnce(new Error("The copy's worker did not stop."));
  await f.registry.get(other);const {directory}=mocks.open.mock.calls[1]![0];
  const outside=await mkdtemp(join(tmpdir(),"dohc-copy-registry-outside-"));cleanups.push(()=>rm(outside,{recursive:true,force:true}));
  await rm(directory,{recursive:true});await symlink(outside,directory,"dir");
  await expect(f.registry.credentialsChanged(null)).rejects.toThrow("The copy's worker did not stop.");
  await expect(f.registry.closeAll()).rejects.toThrow("The copy's worker did not stop.");
});

// A sign-out whose removal of the copy's folder fails, as a busy folder's would.
async function failedSignOut() {
  const f=await fixture();await f.registry.get(f.input);const {directory}=mocks.open.mock.calls[0]![0] as {directory:string};
  files.busy.add(directory);
  await expect(f.registry.credentialsChanged(null)).rejects.toThrow("EBUSY");
  return {...f,directory,root:await realpath(f.input.rootPath)};
}
const nothing={workspaces:[],recordUnreadable:false,sweepPending:false},tag=expect.stringMatching(/^[0-9a-f]{16}$/);
it("names the workspace that still holds a copy it could not remove, and removes it on Try again",async()=>{
  const f=await failedSignOut();
  expect(f.registry.leftover()).toEqual({...nothing,workspaces:[f.root]});expect(f.onLeftover).toHaveBeenCalledOnce();
  expect(await readdir(f.directory)).toEqual(["owned.sqlite"]);
  files.busy.clear();
  await f.registry.removeLeftover();
  expect(await readdir(dirname(f.directory))).toEqual([]);
  expect(f.registry.leftover()).toEqual(nothing);expect(f.onLeftover).toHaveBeenCalledTimes(2);
});
it("records a folder it could not remove, and the next start removes it before another account's copy opens",async()=>{
  const f=await failedSignOut();
  expect(JSON.parse(await readFile(f.record,"utf8"))).toEqual({folders:[f.directory],departed:[tag]});
  files.busy.clear();
  const next=restart(f.record),other={...f.input,lifetime:new AbortController().signal,ownerKey:datasetCopyOwnerKey({serverUrl:"https://account",userId:"other"})};
  let leftAtOpen:boolean|undefined;
  mocks.open.mockImplementationOnce(async options=>{
    leftAtOpen=await lstat(f.directory).then(()=>true,()=>false);
    return {close:vi.fn(async()=>{}),assertOwner:options.assertOwner,data:vi.fn()};
  });
  void next.credentialsChanged(other.ownerKey);
  await next.get(other);
  expect(leftAtOpen).toBe(false);expect(next.leftover()).toEqual(nothing);
  expect(JSON.parse(await readFile(f.record,"utf8"))).toEqual({folders:[],departed:[tag]});
});
it("tells the windows once the start has tried its record, though a read before it saw nothing left",async()=>{
  const f=await failedSignOut(),onLeftover=vi.fn(),next=restart(f.record,[],onLeftover);
  expect(next.leftover()).toEqual(nothing);
  // An unchanged owner answers with the start's own removal.
  await expect(next.credentialsChanged(null)).rejects.toThrow("EBUSY");
  expect(next.leftover()).toEqual({...nothing,workspaces:[f.root]});expect(onLeftover).toHaveBeenCalledOnce();
});
it.skipIf(process.platform==="win32"||process.getuid?.()===0)("says when it cannot read its record, writes nothing over it, and reads it again on Try again",async()=>{
  const f=await failedSignOut();files.busy.clear();
  const text=await readFile(f.record,"utf8"),elsewhere=await mkdtemp(join(tmpdir(),"dohc-copy-registry-elsewhere-"));
  cleanups.push(()=>rm(elsewhere,{recursive:true,force:true}));
  await chmod(f.record,0o000);cleanups.push(()=>chmod(f.record,0o600).catch(()=>undefined));
  const onLeftover=vi.fn(),next=restart(f.record,[elsewhere],onLeftover);
  await expect(next.credentialsChanged(null)).rejects.toThrow("EACCES");
  expect(next.leftover()).toEqual({...nothing,recordUnreadable:true});expect(onLeftover).toHaveBeenCalledOnce();
  // Leaving an account meanwhile names folders of its own, and still writes nothing over the record.
  await next.credentialsChanged(f.input.ownerKey).catch(()=>undefined);
  await expect(next.credentialsChanged(null)).rejects.toThrow("EACCES");
  await chmod(f.record,0o600);expect(await readFile(f.record,"utf8")).toBe(text);
  await next.removeLeftover();
  expect(await readdir(dirname(f.directory))).toEqual([]);
  expect(next.leftover()).toEqual(nothing);expect(onLeftover).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(f.record,"utf8"))).toEqual({folders:[],departed:[tag]});
});
it("records what a sign-out will remove before any copy closes, so a stop part way leaves it for the next start",async()=>{
  const f=await fixture(),copy=await f.registry.get(f.input),{directory}=mocks.open.mock.calls[0]![0] as {directory:string};
  const closing=deferred<void>(),closeCalled=deferred<void>();
  vi.mocked(copy.close).mockImplementationOnce(()=>{closeCalled.resolve();return closing.promise;});
  const removal=f.registry.credentialsChanged(null);
  try {
    await closeCalled.promise;
    // dohc stops while the copy closes. The next start removes it.
    await restart(f.record).credentialsChanged(null);
    expect(await readdir(dirname(directory))).toEqual([]);
  } finally { closing.resolve(); }
  await removal;
});
it("keeps a folder an account left once it signs in again, and opens its copy there",async()=>{
  const f=await failedSignOut();
  // The same account signs in again while its folder is still busy: the folder is its own again.
  await f.registry.credentialsChanged(f.input.ownerKey);
  await f.registry.get({...f.input,lifetime:new AbortController().signal});
  expect(mocks.open.mock.calls[1]![0].directory).toBe(f.directory);
  files.busy.clear();await f.registry.removeLeftover();
  expect(await readdir(f.directory)).toEqual(["owned.sqlite"]);
  expect(f.registry.leftover()).toEqual(nothing);await expect(lstat(f.record)).rejects.toThrow("ENOENT");
  await restart(f.record,[f.input.rootPath]).credentialsChanged(null);
  expect(await readdir(f.directory)).toEqual(["owned.sqlite"]);
});
it.skipIf(process.platform==="win32")("removes copies an earlier run left in every registered workspace when the account changes, and keeps them across a restart",async()=>{
  const f=await fixture();await f.registry.get(f.input);const {directory}=mocks.open.mock.calls[0]![0] as {directory:string};
  // Another registered workspace holds a link where its copies would be.
  const linked=await mkdtemp(join(tmpdir(),"dohc-copy-registry-linked-")),outside=await mkdtemp(join(tmpdir(),"dohc-copy-registry-outside-"));
  cleanups.push(()=>rm(linked,{recursive:true,force:true}),()=>rm(outside,{recursive:true,force:true}));
  await mkdir(join(outside,"0".repeat(64)));await mkdir(join(linked,".dohc","local"),{recursive:true});
  await symlink(outside,join(linked,".dohc","local","dataset-copies"),"dir");
  // dohc starts again signed in to the same account, and nothing opens the copy.
  const next=restart(f.record,[f.input.rootPath,linked]);
  await next.credentialsChanged(f.input.ownerKey);
  expect(await readdir(directory)).toEqual(["owned.sqlite"]);
  await next.credentialsChanged(null);
  expect(await readdir(dirname(directory))).toEqual([]);
  expect(await readdir(outside)).toEqual(["0".repeat(64)]);expect(next.leftover()).toEqual(nothing);
});
it.each(["the next account change","Try again"])("removes what a failed cleanup left at %s, and opens another account's copies meanwhile",async when=>{
  const f=await failedSignOut(),other={...f.input,lifetime:new AbortController().signal,ownerKey:datasetCopyOwnerKey({serverUrl:"https://account",userId:"other"})};
  if(when==="Try again"){
    await expect(f.registry.credentialsChanged(other.ownerKey)).rejects.toThrow("EBUSY");
    // Its copy has a folder of its own, so it opens beside the one left.
    await f.registry.get(other);
    const {directory}=mocks.open.mock.calls[1]![0] as {directory:string};
    files.busy.clear();await f.registry.removeLeftover();
    expect(await readdir(dirname(f.directory))).toEqual([basename(directory)]);
  } else {
    files.busy.clear();await f.registry.credentialsChanged(other.ownerKey);
    expect(await readdir(dirname(f.directory))).toEqual([]);
    await f.registry.get(other);expect(mocks.open).toHaveBeenCalledTimes(2);
  }
  expect(f.registry.leftover()).toEqual(nothing);
});
it.skipIf(process.platform==="win32")("follows no link swapped in for a recorded folder, and removes nothing a record names outside a workspace's copies",async()=>{
  const f=await failedSignOut();files.busy.clear();
  const outside=await mkdtemp(join(tmpdir(),"dohc-copy-registry-outside-")),stray=await mkdtemp(join(tmpdir(),"dohc-copy-registry-stray-"));
  cleanups.push(()=>rm(outside,{recursive:true,force:true}),()=>rm(stray,{recursive:true,force:true}));
  await writeFile(join(outside,"keep.txt"),"not dohc's");await writeFile(join(stray,"keep.txt"),"not dohc's");
  await rm(f.directory,{recursive:true});await symlink(outside,f.directory,"dir");
  await writeFile(f.record,JSON.stringify({folders:[f.directory,stray]}));
  const next=restart(f.record);
  // An unchanged owner answers with the start's own removal.
  await expect(next.credentialsChanged(null)).rejects.toThrow("Collection copy storage changed. Its files were not removed.");
  expect(await readFile(join(outside,"keep.txt"),"utf8")).toBe("not dohc's");expect((await lstat(f.directory)).isSymbolicLink()).toBe(true);
  expect(await readFile(join(stray,"keep.txt"),"utf8")).toBe("not dohc's");
  expect(next.leftover()).toEqual({...nothing,workspaces:[f.root]});expect(JSON.parse(await readFile(f.record,"utf8"))).toEqual({folders:[f.directory]});
});
it.each(["Try again","the next start"])("keeps the look in every workspace owed when it cannot list them, says so, and finishes it at %s",async when=>{
  // A copy an earlier run left in a workspace this run never asked for.
  const earlier=await mkdtemp(join(tmpdir(),"dohc-copy-registry-earlier-")),copy=join(earlier,".dohc","local","dataset-copies","0".repeat(64));
  cleanups.push(()=>rm(earlier,{recursive:true,force:true}));
  await mkdir(copy,{recursive:true});await writeFile(join(copy,"replica.sqlite"),"account data");
  let listing=false;
  const f=await fixture({workspaces:rootPath=>{if(!listing)throw new Error("dohc could not read its workspace list.");return [rootPath,earlier];}});
  await expect(f.registry.credentialsChanged(null)).rejects.toThrow("dohc could not read its workspace list.");
  expect(f.registry.leftover()).toEqual({...nothing,sweepPending:true});expect(f.onLeftover).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(f.record,"utf8"))).toEqual({folders:[],sweepPending:true,departed:[tag]});
  expect(await readdir(copy)).toEqual(["replica.sqlite"]);
  listing=true;
  const registry=when==="Try again"?f.registry:restart(f.record,[f.input.rootPath,earlier]);
  // An unchanged owner answers with the start's own cleanup.
  await (when==="Try again"?registry.removeLeftover():registry.credentialsChanged(null));
  await expect(lstat(copy)).rejects.toThrow("ENOENT");
  expect(registry.leftover()).toEqual(nothing);expect(JSON.parse(await readFile(f.record,"utf8"))).toEqual({folders:[],departed:[tag]});
});
it("removes only the copies of accounts that left in a look still owed, never the signed-in account's, after a restart",async()=>{
  const earlier=await mkdtemp(join(tmpdir(),"dohc-copy-registry-earlier-"));cleanups.push(()=>rm(earlier,{recursive:true,force:true}));
  let listing=false;
  const f=await fixture({workspaces:rootPath=>{if(!listing)throw new Error("dohc could not read its workspace list.");return [rootPath,earlier];}});
  await f.registry.get(f.input);const {directory:first}=mocks.open.mock.calls[0]![0] as {directory:string};
  // Account A's copies from an earlier run in another workspace: one with its tag, and one from before tags.
  const copies=join(earlier,".dohc","local","dataset-copies"),tagged=join(copies,`${basename(first).slice(0,16)}-${"1".repeat(64)}`),untagged=join(copies,"2".repeat(64));
  for(const copy of [tagged,untagged]){await mkdir(copy,{recursive:true});await writeFile(join(copy,"replica.sqlite"),"A's data");}
  // A signs out while dohc can't list the workspaces, and B signs in while it still can't, then opens a copy in each.
  await expect(f.registry.credentialsChanged(null)).rejects.toThrow("workspace list");
  const b=datasetCopyOwnerKey({serverUrl:"https://account",userId:"b"});
  await expect(f.registry.credentialsChanged(b)).rejects.toThrow("workspace list");
  await openedLocalState({workspaceId:"e",rootPath:earlier});
  for(const input of [{...f.input,ownerKey:b,lifetime:new AbortController().signal},{...f.input,workspaceId:"e",rootPath:earlier,ownerKey:b,lifetime:new AbortController().signal}])await f.registry.get(input);
  const mine=mocks.open.mock.calls.slice(1).map(([options])=>(options as {directory:string}).directory);
  // dohc starts again, able to list them, with B still signed in.
  listing=true;
  await restart(f.record,[f.input.rootPath,earlier]).credentialsChanged(null);
  for(const copy of mine)expect(await readdir(copy)).toEqual(["owned.sqlite"]);
  for(const copy of [first,tagged,untagged])await expect(lstat(copy)).rejects.toThrow("ENOENT");
  expect(JSON.parse(await readFile(f.record,"utf8"))).toEqual({folders:[],departed:[tag]});
});
it.skipIf(process.platform==="win32"||process.getuid?.()===0)("forgets the signed-in account's own folders in a record it reads late, and leaves its open copy",async()=>{
  const f=await failedSignOut();files.busy.clear();
  await chmod(f.record,0o000);cleanups.push(()=>chmod(f.record,0o600).catch(()=>undefined));
  // The record can't be read at the next start, and the account that left signs in again and opens its copy.
  const next=restart(f.record,[f.input.rootPath]);
  await expect(next.credentialsChanged(null)).rejects.toThrow("EACCES");
  await expect(next.credentialsChanged(f.input.ownerKey)).rejects.toThrow("EACCES");
  await next.get({...f.input,lifetime:new AbortController().signal});
  expect(mocks.open.mock.calls[1]![0].directory).toBe(f.directory);
  await chmod(f.record,0o600);
  await next.removeLeftover();
  expect(await readdir(f.directory)).toEqual(["owned.sqlite"]);expect(next.leftover()).toEqual(nothing);
  await expect(lstat(f.record)).rejects.toThrow("ENOENT");
});
it("keeps the tags of accounts that left, so a later cleanup removes a copy no earlier one looked at",async()=>{
  const away=await mkdtemp(join(tmpdir(),"dohc-copy-registry-away-"));cleanups.push(()=>rm(away,{recursive:true,force:true}));
  const f=await fixture();await f.registry.get(f.input);const {directory}=mocks.open.mock.calls[0]![0] as {directory:string};
  // A copy of the same account in a workspace that is not in the list when it signs out.
  const stranded=join(away,".dohc","local","dataset-copies",`${basename(directory).slice(0,16)}-${"1".repeat(64)}`);
  await mkdir(stranded,{recursive:true});await writeFile(join(stranded,"replica.sqlite"),"account data");
  await f.registry.credentialsChanged(null);
  expect(await readdir(stranded)).toEqual(["replica.sqlite"]);
  // After a restart the workspace is listed again, and another account signs in and out.
  const next=restart(f.record,[f.input.rootPath,away]),b=datasetCopyOwnerKey({serverUrl:"https://account",userId:"b"});
  await next.credentialsChanged(b);await next.credentialsChanged(null);
  await expect(lstat(stranded)).rejects.toThrow("ENOENT");
  expect(JSON.parse(await readFile(f.record,"utf8"))).toEqual({folders:[],departed:[tag,tag]});
});
