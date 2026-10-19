import { resolveOwnedWorkspaceSharePath } from "./ownedWorkspaceFileReader";
vi.mock("./ownedWorkspaceFileReader", () => ({ resolveOwnedWorkspaceSharePath: vi.fn(async () => null) }));
afterEach(() => vi.mocked(resolveOwnedWorkspaceSharePath).mockReset().mockResolvedValue(null));
import { afterEach, expect, it, vi } from "vitest";
import { createWorkspaceLinksReader } from "./workspaceLinks";
import type { RegistryEntry } from "./registryStore";
import type { ShareViewFiles } from "./shareViewFiles";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
it("uses share authority and marks separate mount engines uncovered", async () => {
  const page = { versionId: "main", subject: { path: "a.md", objectId: "a" }, entries: [], unchecked: [], complete: true, indexBuilding: false, mountsCovered: true, nextCursor: null };
  const result = { versionId: "main", results: [], mountsCovered: true };
  const share = { linksIn: vi.fn(async () => page), linksResolve: vi.fn(async () => result) } as unknown as ShareViewFiles;
  const owned = { incomingLinks: vi.fn(async () => page), resolveLinks: vi.fn(async () => result) } as unknown as VersionedLiveAdapter;
  const withAdapter = async <T>(_workspace: RegistryEntry, run: (adapter: VersionedLiveAdapter) => Promise<T>): Promise<T | null> => run(owned);
  const reader = createWorkspaceLinksReader(withAdapter, () => share);
  const workspace: RegistryEntry = { workspaceId: "ws", rootPath: "root", kind: "personal", mode: "local-first" };
  expect(await reader.incoming(workspace, { subject: { path: "a.md" } })).toEqual(page);
  const mounted = { ...workspace, shareMounts: [{}] } as RegistryEntry;
  expect(await reader.incoming(mounted, { subject: { objectId: "a" } })).toMatchObject({ mountsCovered: false, complete: true, indexBuilding: false });
  expect(await reader.resolve(mounted, { source: "a.md", literals: [] })).toMatchObject({ mountsCovered: false });
  const shared = { ...workspace, shareView: { shareId: "share", access: "view" } } as unknown as RegistryEntry;
  await reader.incoming(shared, { subject: { path: "a.md" } });
  expect(share.linksIn).toHaveBeenCalledWith({ kind: "standalone", workspaceId: "ws" }, { subject: { path: "a.md" } });
});

it("throws when the owner engine session is unavailable, without confusing an absent subject", async () => {
  const reader = createWorkspaceLinksReader(async () => null, () => ({} as ShareViewFiles));
  const workspace = { workspaceId: "ws", rootPath: "root" } as RegistryEntry;
  await expect(reader.incoming(workspace, { subject: { path: "a.md" } })).rejects.toThrow("unavailable");
  await expect(reader.resolve(workspace, { source: "a.md", literals: [] })).rejects.toThrow("unavailable");
});

it("resolves a mounted source through its store and projects found and creation paths", async () => {
  const target = { kind: "mount" as const, workspaceId: "ws", shareId: "share" };
  vi.mocked(resolveOwnedWorkspaceSharePath).mockResolvedValue({ target, path: "notes/source.md" });
  const linksResolve = vi.fn().mockResolvedValue({ versionId: "share-version", mountsCovered: true, results: [
    { path: "found.md", fragment: "section" }, { path: null, create: "notes/new.md", fragment: null },
  ] });
  const owner = vi.fn();
  const reader = createWorkspaceLinksReader(owner, () => ({ linksResolve }) as unknown as ShareViewFiles);
  const workspace = { workspaceId: "ws", rootPath: "root", shareMounts: [{ shareId: "share", label: "Team" }] } as RegistryEntry;
  const literals = [{ kind: "wikilink" as const, literal: "found#section" }, { kind: "wikilink" as const, literal: "new" }];
  expect(await reader.resolve(workspace, { source: "shared-with-me/Team/notes/source.md", literals })).toMatchObject({
    versionId: "share-version", mountsCovered: false, results: [
      { path: "shared-with-me/Team/found.md", fragment: "section" },
      { path: null, create: "shared-with-me/Team/notes/new.md", fragment: null },
    ],
  });
  expect(linksResolve).toHaveBeenCalledWith(target, { source: "notes/source.md", literals });
  expect(owner).not.toHaveBeenCalled();
});

it("queries projected standalone edges and leaves host mounts uncovered", async () => {
  const page={versionId:"main",files:[],entries:[],unchecked:[],complete:true,indexBuilding:false,mountsCovered:true,nextCursor:"next"};
  const linkEdges=vi.fn(async()=>page), linksEdges=vi.fn(async()=>page);
  const reader=createWorkspaceLinksReader(async (_ws,run)=>run({linkEdges} as unknown as VersionedLiveAdapter),()=>({linksEdges} as unknown as ShareViewFiles));
  const owner={workspaceId:"ws",rootPath:"root",kind:"personal",mode:"local-first",shareMounts:[{}]} as RegistryEntry;
  expect(await reader.edges(owner,{cursor:"old"})).toEqual({...page,mountsCovered:false});
  expect(linkEdges).toHaveBeenCalledWith({cursor:"old"});
  const shared={...owner,shareMounts:[],shareView:{shareId:"share",access:"view"}} as unknown as RegistryEntry;
  expect(await reader.edges(shared,{})).toEqual(page);
  expect(linksEdges).toHaveBeenCalledWith({kind:"standalone",workspaceId:"ws"},{});
  expect(linkEdges).toHaveBeenCalledOnce();
});
