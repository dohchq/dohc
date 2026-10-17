import { describe, expect, it, vi } from "vitest";
import { createWorkspaceFileOpens } from "./workspaceFileOpens";

const notes = { workspaceId: "ws-notes" };
const trip = { workspaceId: "ws-trip" };

function harness() {
  const shown = new Map<object, string>();
  const send = vi.fn();
  const opens = createWorkspaceFileOpens<object, typeof notes>({
    shownWorkspaceId: (contents) => shown.get(contents),
    send,
  });
  return { shown, send, opens };
}

describe("createWorkspaceFileOpens", () => {
  it("sends a file at once to a window that already shows its workspace", () => {
    const h = harness();
    const window = {};
    h.shown.set(window, "ws-notes");
    h.opens.request(window, notes, "a.md");
    expect(h.send).toHaveBeenCalledWith(window, notes, "a.md");
  });

  it("holds a file until its window opens that workspace", () => {
    const h = harness();
    const loading = {};
    h.opens.request(loading, notes, "a.md");
    expect(h.send).not.toHaveBeenCalled();
    h.opens.shown(loading, "ws-notes");
    expect(h.send).toHaveBeenCalledWith(loading, notes, "a.md");
    // It goes once.
    h.opens.shown(loading, "ws-notes");
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("keeps only a window's latest file", () => {
    const h = harness();
    const window = {};
    h.opens.request(window, notes, "a.md");
    h.opens.request(window, trip, "day-1.md");
    h.opens.shown(window, "ws-trip");
    expect(h.send.mock.calls).toEqual([[window, trip, "day-1.md"]]);
  });

  it("drops a held file when its window opens another workspace first", () => {
    const h = harness();
    const window = {};
    h.opens.request(window, notes, "a.md");
    h.opens.shown(window, "ws-trip");
    h.opens.shown(window, "ws-notes");
    expect(h.send).not.toHaveBeenCalled();
  });
});
