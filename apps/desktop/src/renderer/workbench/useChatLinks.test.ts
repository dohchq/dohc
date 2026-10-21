// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "../../testing/deferred";
import { useChatLinks } from "./useChatLinks";

function page(wire="a", nextCursor:string|null="next") {
  return { versionId:"main",subject:{channelWireId:wire},entries:[],unchecked:[],complete:true,
    indexBuilding:false,mountsCovered:true,sharedChannelRowsUncovered:0,nextCursor };
}
function setup() {
  const read=vi.fn(),onError=vi.fn();
  vi.stubGlobal("dohcDesktop",{chatLinks:read});
  const hook=renderHook(({workspaceId,channelWireId})=>useChatLinks({workspaceId,channelWireId,onError}),
    {initialProps:{workspaceId:"w",channelWireId:"a"}});
  return {...hook,read,onError};
}
afterEach(()=>vi.unstubAllGlobals());

it("reads lazily and requests only the next page on demand, including empty pages",async()=>{
  const h=setup();h.read.mockResolvedValueOnce(page()).mockResolvedValueOnce(page("a",null));
  expect(h.read).not.toHaveBeenCalled();
  await act(()=>h.result.current.load());
  expect(h.read).toHaveBeenCalledExactlyOnceWith({workspaceId:"w",channelWireId:"a"});
  await act(()=>h.result.current.loadMore());
  expect(h.read).toHaveBeenLastCalledWith({workspaceId:"w",channelWireId:"a",cursor:"next"});
  expect(h.result.current.pages).toHaveLength(2);
  await act(()=>h.result.current.loadMore());expect(h.read).toHaveBeenCalledTimes(2);
});
it.each(["workspace","conversation"] as const)("guards stale success and failure across %s A-B-A",async kind=>{
  const h=setup(),old=deferred<ReturnType<typeof page>>(),failure=deferred<never>();
  h.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(failure.promise).mockResolvedValue(page("fresh"));
  let first!:Promise<void>,second!:Promise<void>;
  act(()=>{first=h.result.current.load();});
  h.rerender(kind==="workspace"?{workspaceId:"b",channelWireId:"a"}:{workspaceId:"w",channelWireId:"b"});
  act(()=>{second=h.result.current.load();});
  h.rerender({workspaceId:"w",channelWireId:"a"});
  await act(()=>h.result.current.load());
  await act(async()=>{old.resolve(page("stale"));failure.reject(Error("stale"));await Promise.all([first,second]);});
  expect(h.result.current.pages.map(p=>p.subject.channelWireId)).toEqual(["fresh"]);
  expect(h.onError).not.toHaveBeenCalled();expect(h.result.current.loading).toBe(false);
});
it("a refresh supersedes pagination and duplicate pagination does not consume the cursor twice",async()=>{
  const h=setup(),older=deferred<ReturnType<typeof page>>();
  h.read.mockResolvedValueOnce(page()).mockReturnValueOnce(older.promise).mockResolvedValueOnce(page("refresh",null));
  await act(()=>h.result.current.load());
  let pending!:Promise<void>;
  act(()=>{pending=h.result.current.loadMore();});
  await act(()=>h.result.current.loadMore());
  expect(h.read).toHaveBeenCalledTimes(2);
  await act(()=>h.result.current.load());
  await act(async()=>{older.resolve(page("old"));await pending;});
  expect(h.result.current.pages.map(p=>p.subject.channelWireId)).toEqual(["refresh"]);
});
it("reports current errors but suppresses errors after unmount",async()=>{
  const h=setup(),pending=deferred<never>();
  h.read.mockRejectedValueOnce(Error("current")).mockReturnValueOnce(pending.promise);
  await act(()=>h.result.current.load());expect(h.onError).toHaveBeenCalledTimes(1);
  let work!:Promise<void>;act(()=>{work=h.result.current.load();});h.unmount();
  pending.reject(Error("late"));await work;expect(h.onError).toHaveBeenCalledTimes(1);
});

it("distinguishes idle, loading, loaded empty and unavailable; refresh keeps existing pages", async () => {
  const h = setup(), refresh = deferred<ReturnType<typeof page>>();
  expect(h.result.current.status).toBe("idle");
  h.read.mockResolvedValueOnce(page()).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce(null);
  await act(() => h.result.current.load());
  expect(h.result.current.status).toBe("loaded");
  let pending!: Promise<void>;
  act(() => { pending = h.result.current.load(); });
  expect(h.result.current.status).toBe("loading");
  expect(h.result.current.pages).toHaveLength(1);
  await act(async () => { refresh.resolve(page("fresh", null)); await pending; });
  expect(h.result.current.status).toBe("loaded");
  expect(h.result.current.pages.map(p => p.subject.channelWireId)).toEqual(["fresh"]);
  await act(() => h.result.current.load());
  expect(h.result.current.status).toBe("unavailable");
  expect(h.result.current.pages).toEqual([]);
  h.read.mockResolvedValueOnce(page("empty", null));
  await act(() => h.result.current.load());
  expect(h.result.current.status).toBe("loaded");
  expect(h.result.current.pages[0]!.entries).toEqual([]);
});

it("marks a failed refresh unavailable while preserving its pages", async () => {
  const h = setup();
  h.read.mockResolvedValueOnce(page()).mockRejectedValueOnce(Error("refresh"));
  await act(() => h.result.current.load());
  await act(() => h.result.current.load());
  expect(h.result.current.status).toBe("unavailable");
  expect(h.result.current.pages).toHaveLength(1);
  expect(h.onError).toHaveBeenCalledOnce();
});

it("ends a failed first load as unavailable and allows an explicit retry", async () => {
  const h = setup();
  const error = Error("first load");
  h.read.mockRejectedValueOnce(error).mockResolvedValueOnce(page());
  await act(() => h.result.current.load());
  expect(h.result.current.status).toBe("unavailable");
  expect(h.result.current.loading).toBe(false);
  expect(h.result.current.pages).toEqual([]);
  expect(h.onError).toHaveBeenCalledExactlyOnceWith(error);
  expect(h.read).toHaveBeenCalledOnce();
  await act(() => h.result.current.load());
  expect(h.result.current.status).toBe("loaded");
});
