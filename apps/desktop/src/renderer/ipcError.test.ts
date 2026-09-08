import { describe, expect, it } from "vitest";
import { ipcErrorMessage } from "./ipcError";

describe("IPC error messages", () => {
  it("unwraps Electron errors without rewriting their cause", () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'read': Error: EACCES")))
      .toBe("EACCES");
    expect(ipcErrorMessage(new Error("Error invoking remote method 'read': unavailable")))
      .toBe("unavailable");
  });

  it("preserves raw reasons and applies requested display fallbacks", () => {
    expect(ipcErrorMessage("  unavailable  ")).toBe("  unavailable  ");
    expect(ipcErrorMessage(new Error("  unavailable  "), "Retry")).toBe("unavailable");
    expect(ipcErrorMessage(new Error("  "), "Retry")).toBe("Retry");
    expect(ipcErrorMessage({}, "Retry")).toBe("Retry");
  });
});
