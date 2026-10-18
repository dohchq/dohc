// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { resolveLinkNavigation } from "./wikilinkNavigation";
afterEach(() => vi.unstubAllGlobals());
it.each(["wikilink", "markdown"] as const)("keeps %s fragment-only navigation in its source", async kind => {
  const linksResolve = vi.fn();
  vi.stubGlobal("dohcDesktop", { linksResolve });
  expect(await resolveLinkNavigation("ws", "source.md", "#heading", kind, 7)).toEqual({ path: "source.md", headingTarget: { anchor: "heading", nonce: 7 } });
  expect(linksResolve).not.toHaveBeenCalled();
});
it("uses only the engine result, including ambiguous and hash-bearing targets", async () => {
  const linksResolve = vi.fn().mockResolvedValueOnce({ results: [{ path: "actual.md", fragment: "part" }] }).mockResolvedValueOnce({ results: [null] });
  vi.stubGlobal("dohcDesktop", { linksResolve });
  expect(await resolveLinkNavigation("ws", "source.md", "actual#part", "wikilink", 8)).toEqual({ path: "actual.md", headingTarget: { anchor: "part", nonce: 8 } });
  expect(linksResolve).toHaveBeenCalledWith({ workspaceId: "ws", source: "source.md", literals: [{ kind: "wikilink", literal: "actual#part" }] });
  expect(await resolveLinkNavigation("ws", "source.md", "ambiguous", "wikilink", 9)).toBeNull();
});
it("keeps an explicit empty fragment from an engine result", async () => {
  vi.stubGlobal("dohcDesktop", { linksResolve: vi.fn().mockResolvedValue({ results: [{ path: "target.md", fragment: "" }] }) });
  expect(await resolveLinkNavigation("ws", "source.md", "target#", "wikilink", 1)).toEqual({ path: "target.md", headingTarget: { anchor: "", nonce: 1 } });
});
