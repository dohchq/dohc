import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// main.ts is Electron's entry point and cannot be imported under Vitest. Pin
// the two call-site regions whose distinction matters: selecting a registered
// workspace changes renderer preference only, while registry membership
// changes still rebuild the operating-system surfaces.
const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);

function region(start: string, end: string): string {
  const startAt = mainSource.indexOf(start);
  const endAt = mainSource.indexOf(end, startAt + start.length);
  if (startAt < 0 || endAt < 0) {
    throw new Error(`Missing main.ts region ${start} .. ${end}`);
  }
  return mainSource.slice(startAt, endAt);
}

describe("native workspace surface refresh wiring", () => {
  it("does not rebuild native surfaces when an existing workspace opens", () => {
    const openWorkspace = region(
      "ipcMain.handle(CHANNELS.openWorkspace",
      "// Named versions",
    );

    expect(openWorkspace).not.toContain("refreshNativeWorkspaceSurfaces");
  });

  it("still rebuilds native surfaces when registry membership changes", () => {
    const createWorkspace = region(
      "ipcMain.handle(CHANNELS.createLocalWorkspace",
      "ipcMain.handle(CHANNELS.attachWorkspaceFolder",
    );

    expect(createWorkspace).toContain("registerPhysicalWorkspace(created)");
    expect(createWorkspace).toContain("refreshNativeWorkspaceSurfaces()");
  });
});
