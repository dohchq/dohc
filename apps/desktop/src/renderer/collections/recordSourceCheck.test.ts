// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../../ipc/bridgeContract";
import { useRecordSourceCheck } from "./recordSourceCheck";

afterEach(() => vi.unstubAllGlobals());

function readsAs(read: DohcDesktopBridge["readWorkspaceText"]) {
  const readWorkspaceText = vi.fn(read);
  vi.stubGlobal("dohcDesktop", { readWorkspaceText });
  return readWorkspaceText;
}

const RECORD = "---\nid: rec-1\nstatus: draft\n---\n\nBody\n";

describe("useRecordSourceCheck", () => {
  it("checks the record's file and reports the bytes it checked", async () => {
    const read = readsAs(async () => ({ text: RECORD, contentHash: "5a".repeat(32), truncated: false }));
    const { result } = renderHook(() => useRecordSourceCheck("ws-1", "tasks/Plan.md"));
    expect(result.current).toEqual({ state: "checking" });
    await waitFor(() => expect(result.current).toEqual({ state: "clear", contentHash: "5a".repeat(32) }));
    expect(read).toHaveBeenCalledWith({ workspaceId: "ws-1", relativePath: "tasks/Plan.md" });
  });

  it("finds a lossy note", async () => {
    readsAs(async () => ({ text: `${RECORD}\n<details>\n\nHidden.\n</details>\n`, contentHash: "5b".repeat(32), truncated: false }));
    const { result } = renderHook(() => useRecordSourceCheck("ws-1", "tasks/Plan.md"));
    await waitFor(() => expect(result.current).toEqual({ state: "lossy" }));
  });

  it.each<[string, DohcDesktopBridge["readWorkspaceText"]]>([
    ["fails", async () => { throw new Error("EBUSY"); }],
    ["is partial", async () => ({ text: RECORD, contentHash: null, truncated: true })],
  ])("can't check a record whose read %s", async (_, read) => {
    readsAs(read);
    const { result } = renderHook(() => useRecordSourceCheck("ws-1", "tasks/Plan.md"));
    await waitFor(() => expect(result.current).toEqual({ state: "unreadable" }));
  });

  it("checks again for another record", async () => {
    readsAs(async ({ relativePath }) => ({
      text: relativePath === "tasks/Plan.md" ? RECORD : `${RECORD}\n<details>\n\nHidden.\n</details>\n`,
      contentHash: relativePath === "tasks/Plan.md" ? "5d".repeat(32) : "5e".repeat(32),
      truncated: false,
    }));
    const view = renderHook(({ path }) => useRecordSourceCheck("ws-1", path), { initialProps: { path: "tasks/Plan.md" } });
    await waitFor(() => expect(view.result.current.state).toBe("clear"));
    view.rerender({ path: "tasks/Other.md" });
    expect(view.result.current).toEqual({ state: "checking" });
    await waitFor(() => expect(view.result.current).toEqual({ state: "lossy" }));
  });
});
