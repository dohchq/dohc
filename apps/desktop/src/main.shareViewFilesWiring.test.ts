import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function sourceBlock(startMarker: string, endMarker: string): string {
  const start = mainSource.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = mainSource.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return mainSource.slice(start, end);
}

function functionSource(signature: string): string {
  return sourceBlock(signature, "\n}\n");
}

function handlerSource(channel: string): string {
  return sourceBlock(`ipcMain.handle(CHANNELS.${channel}`, "\n  });");
}

describe("ShareViewFiles main-process wiring", () => {
  it("exports an exact mount root through its owner without an empty relative path", () => {
    const collect = functionSource("async function collectOwnedZipEntries(");

    expect(collect).toContain(
      '...(routed.path === "" ? {} : { relativePath: routed.path }),',
    );
    expect(collect).not.toContain("const mountRoot =");
  });

  it("falls back to registry and folder cleanup when registered unmount fails", () => {
    const handler = handlerSource("mountShare");
    const registeredAt = handler.indexOf("if (registered) {");
    const rollback = handler.slice(
      registeredAt,
      handler.indexOf("notifyRenderer();", registeredAt),
    );
    const unmountAt = rollback.indexOf(".unmount(lease,");
    const fallbackAt = rollback.indexOf("catch (unmountError)");
    const registryAt = rollback.indexOf("setWorkspaceShareMounts(", fallbackAt);
    const registryCatchAt = rollback.indexOf("catch (registryError)", registryAt);
    const folderAt = rollback.indexOf("removeMountFolder(", fallbackAt);

    expect(registeredAt).toBeGreaterThan(-1);
    expect(unmountAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(unmountAt);
    expect(registryAt).toBeGreaterThan(fallbackAt);
    expect(registryCatchAt).toBeGreaterThan(registryAt);
    expect(folderAt).toBeGreaterThan(registryCatchAt);
  });

  it("repairs available projections before disk-only reads even when status says current", () => {
    const one = functionSource("async function ensureOwnedProjectionCurrent(");
    const all = functionSource("async function ensureAllOwnedProjectionsCurrent(");

    expect(one).toContain('if (status.state === "unavailable") return;');
    expect(one).not.toContain('status.state === "current"');
    expect(one).toContain(
      'shareViewFiles.reconcile(lease, routed.target, "repair")',
    );

    expect(all).not.toContain('status.state === "pending"');
    expect(all).toContain('status.state !== "unavailable"');
    expect(all).toContain(
      'await shareViewFiles.reconcile(lease, target, "repair");',
    );
  });
});
