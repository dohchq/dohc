import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { workspaceWriteRefusal } from "./workspaces/shareWriteGate";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function handlerSource(channel: string): string {
  const marker = `CHANNELS.${channel},`;
  const markerAt = mainSource.indexOf(marker);
  const start = mainSource.lastIndexOf("ipcMain.handle(", markerAt);
  if (markerAt < 0 || start < 0) throw new Error(`Missing IPC handler for ${channel}`);
  const next = mainSource.indexOf("ipcMain.handle(", markerAt + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

// main.ts exports nothing, so its own listOfferedPlugins/addOfferedPlugin
// handlers cannot be invoked directly here — this instead proves both
// halves of the same boundary: the source scan pins that each handler
// STATES assertWritableWorkspace(workspace) before any pipeline read or
// filesystem write, and the real, unmocked workspaceWriteRefusal it calls
// genuinely refuses a shared view shaped exactly as one carries it (and
// admits an ordinary workspace) — the same real decision function, not a
// mock of it.
describe("main-process offer-plugin authorization", () => {
  it("gates both offer handlers on the workspace write boundary, which genuinely refuses a shared view", () => {
    for (const channel of ["listOfferedPlugins", "addOfferedPlugin"]) {
      const handler = handlerSource(channel);
      const gateAt = handler.indexOf("assertWritableWorkspace(workspace);");
      expect(gateAt, `${channel}: missing a direct assertWritableWorkspace(workspace) call`)
        .toBeGreaterThan(-1);

      const pipelineListAt = handler.indexOf("pipeline.list()");
      if (pipelineListAt >= 0) {
        expect(
          gateAt,
          `${channel}: the gate must precede reading the pipeline's plugin list`,
        ).toBeLessThan(pipelineListAt);
      }

      const addOfferedPluginCallAt = handler.indexOf("await addOfferedPlugin({");
      if (addOfferedPluginCallAt >= 0) {
        expect(
          gateAt,
          `${channel}: the gate must precede the filesystem write`,
        ).toBeLessThan(addOfferedPluginCallAt);
      }
    }

    const refusal = workspaceWriteRefusal({
      shareId: "share-1",
      granterEmail: "owner@example.com",
      relayUrl: "https://relay.test",
      ended: false,
      grantedSelector: { paths: ["docs"], versionId: null, access: "edit" },
    });
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("shared view");

    // An ordinary workspace (no share view marker at all) is exactly what
    // both handlers require before they touch pipeline.list() or the
    // filesystem: refusal here would break every real workspace's Plugins
    // view, not only a shared one.
    expect(workspaceWriteRefusal(undefined)).toBeNull();
  });
});
