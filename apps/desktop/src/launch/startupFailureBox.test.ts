import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRegistryStore } from "../workspaces/registryStore";
import { createTestScratch } from "../workspaces/testTemp";
import { startupFailureBox } from "./startupFailureBox";

function listingFailure(registryFile: string): unknown {
  try {
    createRegistryStore(registryFile).list();
  } catch (error) {
    return error;
  }
  throw new Error("The registry read did not fail.");
}

describe("startupFailureBox", () => {
  it.each([
    ["an unreadable", (path: string) => mkdir(path), "Cannot read workspace registry"],
    ["a corrupt", (path: string) => writeFile(path, "{ this is not json"), "Workspace registry is corrupt"],
    ["a versionless", (path: string) => writeFile(path, "{}"), "Workspace registry has an unexpected version"],
    ["a version 0", (path: string) => writeFile(path, '{"version":0}'), "Workspace registry has an unexpected version"],
    ["a text version", (path: string) => writeFile(path, '{"version":"2"}'), "Workspace registry has an unexpected version"],
  ])("tells the person how to recover from %s registry", async (_kind, prepare, detail) => {
    const registryFile = join(await createTestScratch("dohc-startup-box-"), "dohc-workspaces.json");
    await prepare(registryFile);
    expect(startupFailureBox(listingFailure(registryFile))).toEqual({
      title: "dohc couldn't read its workspace registry",
      content: [
        "Your files are untouched. Fix or move the registry file named in the technical details, then relaunch dohc.",
        "",
        "Technical details",
        `File: ${registryFile}`,
        `Detail: ${detail} (${registryFile}); refusing to overwrite it.`,
      ].join("\n"),
    });
  });

  it("tells the person to update dohc for a registry a newer dohc wrote", async () => {
    const registryFile = join(await createTestScratch("dohc-startup-box-"), "dohc-workspaces.json");
    await writeFile(registryFile, JSON.stringify({ version: 2, workspaces: [] }));
    expect(startupFailureBox(listingFailure(registryFile))).toEqual({
      title: "dohc couldn't read its workspace registry",
      content: [
        "Your files are untouched. A newer version of dohc wrote this registry. Update dohc to open it.",
        "",
        "Technical details",
        `File: ${registryFile}`,
        `Detail: Workspace registry version 2 is newer than supported (${registryFile}); refusing to overwrite it.`,
      ].join("\n"),
    });
  });

  it("keeps the generic box for any other startup failure", () => {
    expect(startupFailureBox(new Error("settings unavailable"))).toEqual({
      title: "dohc failed to start",
      content: "settings unavailable\n\nRestart dohc. If it fails again, review the desktop logs.",
    });
  });
});
