import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginPanelPreviewStarter } from "./pluginPanelLifecycle";
import { pluginDataDir } from "./pluginLocalState";
import { pluginIdToSafePath } from "./pluginSourceSnapshot";
import { createTestScratch } from "../workspaces/testTemp";
import type { CreatedWorkspace } from "../workspaces/createWorkspaceFolder";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(stops.splice(0).map(stop => stop())); });

async function fixture(pluginId = "plugin") {
  const root = await createTestScratch("plugin-panel-start-");
  const workspace: CreatedWorkspace = { workspaceId: "workspace", rootPath: join(root, "workspace"), kind: "personal", mode: "local-first" };
  let state = join(root, "state");
  const starter = createPluginPanelPreviewStarter(() => state);
  const snapshot = () => join(pluginDataDir(state, workspace.rootPath), "plugins", pluginIdToSafePath(pluginId), "snapshot");
  const write = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  const start = async (entry = "panel/index.html") => {
    const preview = await starter({ workspace, pluginId, panel: { entry } });
    stops.push(preview.stop);
    return preview;
  };
  return { root, workspace, starter, snapshot, write, start, setState: (next: string) => { state = next; } };
}

describe("plugin panel preview startup", () => {
  it.each(["plugin", "@scope/plugin"])("serves only the approved snapshot for %s", async (pluginId) => {
    const f = await fixture(pluginId);
    await f.write(join(f.snapshot(), "panel/index.html"), "approved snapshot");
    await f.write(join(f.workspace.rootPath, "plugins", "plugin", "panel/index.html"), "unapproved workspace");
    const preview = await f.start();
    const response = await fetch(preview.url);
    expect(new URL(preview.url).hostname).toBe("127.0.0.1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toBe("approved snapshot");
  });

  it("reads the current state directory for every preview start", async () => {
    const f = await fixture();
    await f.write(join(f.snapshot(), "panel/index.html"), "first snapshot");
    const first = await f.start();
    f.setState(join(f.root, "next-state"));
    await f.write(join(f.snapshot(), "panel/index.html"), "second snapshot");
    const second = await f.start();
    await expect(fetch(first.url).then(response => response.text())).resolves.toBe("first snapshot");
    await expect(fetch(second.url).then(response => response.text())).resolves.toBe("second snapshot");
  });

  it("refuses a missing approved snapshot even when the live workspace has the panel", async () => {
    const f = await fixture();
    await f.write(join(f.workspace.rootPath, "plugins/plugin/panel/index.html"), "unapproved workspace");
    await expect(f.start()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["../../outside/index.html", "linked/index.html"])("refuses an entry outside its approved snapshot through %s", async (entry) => {
    const f = await fixture();
    await f.write(join(f.snapshot(), "panel/index.html"), "approved");
    const outside = entry.startsWith("..") ? join(f.snapshot(), "../../outside") : join(f.root, "outside");
    await f.write(join(outside, "index.html"), "outside");
    if (entry.startsWith("linked")) await symlink(outside, join(f.snapshot(), "linked"), "junction");
    await expect(f.start(entry)).rejects.toThrow("Static root escapes its containment root");
  });

  it("refuses reserved metadata as a panel root", async () => {
    const f = await fixture();
    await f.write(join(f.snapshot(), ".dohc/index.html"), "private metadata");
    await expect(f.start(".dohc/index.html")).rejects.toThrow("reserved metadata path");
  });

  it("rejects an invalid plugin id before looking for a snapshot", async () => {
    const f = await fixture();
    await expect(f.starter({ workspace: f.workspace, pluginId: "../other", panel: { entry: "index.html" } }))
      .rejects.toThrow("manifest name pattern");
  });
});
