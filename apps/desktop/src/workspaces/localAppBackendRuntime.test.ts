import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { utilityProcess } from "electron";
import { createDesktopAppRuntimeLauncher } from "./localAppBackendRuntime";

function fixture(closeAfterReply: boolean) {
  const child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
  const fork = vi.fn(() => child);
  const onMessage = vi.fn(), onError = vi.fn(), onExit = vi.fn();
  const launch = createDesktopAppRuntimeLauncher({ fork } as unknown as Pick<typeof utilityProcess, "fork">, closeAfterReply);
  const handle = launch({ entryPath: "C:/runtime/worker.mjs", cwd: "C:/workspace/private-worker", env: {}, onMessage, onError, onExit });
  return { child, fork, handle, onMessage, onError, onExit };
}

describe("desktop app runtime lifetimes", () => {
  it("keeps the persistent worker alive across prepare, commit, and subsequent replies", () => {
    const f = fixture(false);
    f.child.emit("spawn");
    f.handle.postMessage({ kind: "prepare", id: "one" });
    f.child.emit("message", { kind: "prepared", id: "one" });
    f.handle.postMessage({ kind: "finalize", id: "one" });
    f.child.emit("message", { kind: "finalized", id: "one" });
    expect(f.onMessage).toHaveBeenCalledTimes(2);
    expect(f.child.postMessage.mock.calls).toEqual([[{ kind: "prepare", id: "one" }], [{ kind: "finalize", id: "one" }]]);
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.fork.mock.calls[0]).toEqual(["C:/runtime/worker.mjs", [], expect.objectContaining({ env: {}, cwd: "C:/workspace/private-worker" })]);
  });

  it("closes a one-shot worker after returning its reply", () => {
    const f = fixture(true);
    f.child.emit("message", { ok: true });
    expect(f.onMessage).toHaveBeenCalledWith({ ok: true });
    expect(f.child.postMessage).toHaveBeenCalledWith({ kind: "close" });
    f.child.emit("exit", 0);
    expect(f.onExit).toHaveBeenCalledWith(0);
  });

  it("keeps cancellation effective when the process has not spawned yet", () => {
    const f = fixture(false);
    f.handle.kill();
    f.child.emit("spawn");
    expect(f.child.kill).toHaveBeenCalledTimes(2);
    f.child.emit("error", new Error("private runtime detail"));
    expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "The app operation process failed." }));
  });
});
