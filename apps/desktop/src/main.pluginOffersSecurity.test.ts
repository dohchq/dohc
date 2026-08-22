import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { workspaceWriteRefusal } from "./workspaces/shareWriteGate";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

// Same technique as main.chatSecurity.test.ts's handlerSource(): a static
// scan over the handler's own source text. ensurePluginPipeline already
// calls assertWritableWorkspace before a pipeline exists (a shared view can
// never get one to read or write through), so this boundary already holds
// at runtime — this test instead pins that each handler STATES the gate
// directly, the way every other workspace-mutating handler in this file
// does, so an auditor (human or grep) never has to trust an indirect call
// three functions away, and a future refactor of the pipeline-lifecycle
// helper can't silently drop the check for these two handlers alone.
function handlerSource(channel: string): string {
  const marker = `CHANNELS.${channel},`;
  const markerAt = mainSource.indexOf(marker);
  const start = mainSource.lastIndexOf("ipcMain.handle(", markerAt);
  if (markerAt < 0 || start < 0) throw new Error(`Missing IPC handler for ${channel}`);
  const next = mainSource.indexOf("ipcMain.handle(", markerAt + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

describe("main-process offer-plugin authorization", () => {
  it("gates both offer handlers on the workspace write boundary, directly and before any read or write", () => {
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
  });

  // The source-order pin above proves each handler STATES
  // assertWritableWorkspace(workspace) before any read or write.
  // assertWritableWorkspace is itself one line over workspaceWriteRefusal
  // (shareWriteGate.ts's own doc comment), so this runs THAT real,
  // unmocked decision against a shared view shaped exactly as a share-view
  // workspace's registry entry actually carries it — the runtime half of
  // the proof a source scan alone cannot give: not only does the call
  // appear in the right place, but calling it for a shared view genuinely
  // refuses, worded the way the handler's caller will see it.
  it("refuses a shared view at the exact gate both offer handlers state (runtime, not only source)", () => {
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
