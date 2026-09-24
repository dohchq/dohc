import { describe, expect, it } from "vitest";
import { ipcErrorMessage } from "./ipcError";

describe("IPC error messages", () => {
  it("drops Electron's prefix and the class name, and keeps a sentence written for a person", () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'read': Error: Sync this workspace first.")))
      .toBe("Sync this workspace first.");
    expect(ipcErrorMessage(new Error("Error invoking remote method 'read': unavailable"))).toBe("unavailable");
    expect(ipcErrorMessage(new Error(
      "Error invoking remote method 'read': YDocOpenRacedError: notes.md changed while it was opening. Open it again.",
    ))).toBe("notes.md changed while it was opening. Open it again.");
  });

  it("gives the class and code's words, or the fallback, instead of a raw code", () => {
    expect(ipcErrorMessage(new Error(
      "Error invoking remote method 'read': DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
    ), "Could not read.")).toBe("Could not read. dohc is still reading this workspace's files. Try again when it finishes.");
    expect(ipcErrorMessage(new Error(
      "Error invoking remote method 'send': PersistentRuntimeError [worker_stopped]: The dataset worker stopped.",
    ), "Could not send that message.")).toBe("Could not send that message. It stopped before it finished. Try again.");
    expect(ipcErrorMessage(new Error(
      "Error invoking remote method 'read': DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
    ))).toBe("dohc is still reading this workspace's files. Try again when it finishes.");
    expect(ipcErrorMessage(new Error(
      "Error invoking remote method 'prepare': DaemonRefusalError [INVALID_PARAMS]: invalid-input",
    ), "dohc could not prepare this app. Try again.")).toBe("dohc could not prepare this app. Try again.");
    expect(ipcErrorMessage(new Error("Error invoking remote method 'read': Error: EPIPE"))).toBe("dohc could not finish that.");
    expect(ipcErrorMessage(new Error("Error invoking remote method 'read': Error [EACCES]: EACCES: permission denied")))
      .toBe("dohc does not have permission to use this file or folder.");
  });

  it("applies requested display fallbacks", () => {
    expect(ipcErrorMessage("  unavailable  ")).toBe("unavailable");
    expect(ipcErrorMessage(new Error("  unavailable  "), "Retry")).toBe("unavailable");
    expect(ipcErrorMessage(new Error("  "), "Retry")).toBe("Retry");
    expect(ipcErrorMessage({}, "Retry")).toBe("Retry");
  });
});
