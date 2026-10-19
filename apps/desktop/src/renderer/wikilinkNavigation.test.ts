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
it("uses the resolved engine path and fragment", async () => {
  const linksResolve = vi.fn().mockResolvedValueOnce({ results: [{ path: "actual.md", fragment: "part" }] });
  vi.stubGlobal("dohcDesktop", { linksResolve });
  expect(await resolveLinkNavigation("ws", "source.md", "actual#part", "wikilink", 8)).toEqual({ path: "actual.md", headingTarget: { anchor: "part", nonce: 8 } });
  expect(linksResolve).toHaveBeenCalledWith({ workspaceId: "ws", source: "source.md", literals: [{ kind: "wikilink", literal: "actual#part" }] });
});
it("keeps an explicit empty fragment from an engine result", async () => {
  vi.stubGlobal("dohcDesktop", { linksResolve: vi.fn().mockResolvedValue({ results: [{ path: "target.md", fragment: "" }] }) });
  expect(await resolveLinkNavigation("ws", "source.md", "target#", "wikilink", 1)).toEqual({ path: "target.md", headingTarget: { anchor: "", nonce: 1 } });
});

it.each([
  ["ambiguous", "notes/ambiguous.md", null],
  ["./guide.markdown", "notes/guide.markdown", null],
  ["./new%23plan.md", "notes/new#plan.md", null],
  ["./new%23release%231.md#decisions", "notes/new#release#1.md", "decisions"],
])("opens the engine creation path for %s", async (literal, create, fragment) => {
  vi.stubGlobal("dohcDesktop", { linksResolve: vi.fn().mockResolvedValue({ results: [{ path: null, create, fragment }] }) });
  expect(await resolveLinkNavigation("ws", "notes/source.md", literal, "markdown", 9)).toEqual({
    path: create, ...(fragment === null ? {} : { headingTarget: { anchor: fragment, nonce: 9 } }),
  });
});
