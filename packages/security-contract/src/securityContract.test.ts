import { describe, expect, it } from "vitest";
import {
  AGENT_CHANNEL_WIRE_ID,
  GENERAL_CHANNEL_WIRE_ID,
  classifyEngineFilePath,
  classifyEngineFilePathForRead,
} from "./index";

// The sandboxed renderer has no `process`. Deleting it is what makes a
// hidden read throw the same ReferenceError the renderer throws.
function withoutProcess<T>(run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
  if (!descriptor) throw new Error("expected a process global to remove");
  Reflect.deleteProperty(globalThis, "process");
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, "process", descriptor);
  }
}

describe("security contract", () => {
  it("keeps wire ids and share-read secret classification stable", () => {
    expect(AGENT_CHANNEL_WIRE_ID).toBe("channel_wire_agent_v1");
    expect(GENERAL_CHANNEL_WIRE_ID).toBe("channel_wire_general_v1");
    expect(classifyEngineFilePath("notes/brief.md")).toEqual({ kind: "tracked" });
    expect(classifyEngineFilePathForRead("shared-with-me/alex/.env", "linux")).toEqual({
      kind: "secret",
    });
  });

  it("classifies a read path from the platform it is given, with no process global", () => {
    const classify = (path: string, platform: NodeJS.Platform) =>
      withoutProcess(() => classifyEngineFilePathForRead(path, platform).kind);

    expect(classify("trip/plan.md", "win32")).toBe("tracked");
    expect(classify("trip/plan.md", "darwin")).toBe("tracked");
    // A colon in a relative read path is an NTFS stream on Windows only.
    expect(classify("trip/plan.md:hidden", "win32")).toBe("ignored");
    expect(classify("trip/plan.md:hidden", "linux")).toBe("tracked");
    for (const platform of ["win32", "linux"] as const) {
      expect(classify("config/.env", platform)).toBe("secret");
      expect(classify(".env.local", platform)).toBe("secret");
      expect(classify("shared-with-me/alex/.env", platform)).toBe("secret");
    }
  });
});
