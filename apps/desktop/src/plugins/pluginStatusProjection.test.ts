import { describe, expect, it } from "vitest";
import { PluginStatusRecord } from "../ipc/bridgeContract";
import type { InstalledPluginRecord } from "./pluginDiscovery";
import type { DohcPluginManifest } from "./pluginManifestSchema";
import {
  cloneStatus,
  initialPluginStatus,
  invalidPluginStatus,
  pipelineError,
  projectPluginStatus,
} from "./pluginStatusProjection";

function manifest(label: string): DohcPluginManifest {
  return {
    version: 1,
    name: "example-plugin",
    entry: "src/index.ts",
    displayName: label,
    settings: [{
      key: "enabled",
      label,
      type: "boolean",
      description: "Enable this plugin.",
      default: true,
    }],
    webApps: [{ id: "app", title: label, instanced: true }],
    panels: [{ id: "panel", title: label, entry: "panel.html", placement: "view" }],
    commands: [{ id: "command", title: label }],
  };
}

function candidate(label = "Candidate"): InstalledPluginRecord {
  return {
    id: "example-plugin",
    directoryName: "source-directory",
    rootPath: "/workspace/plugins/source-directory",
    manifest: manifest(label),
    iconPath: "candidate.svg",
    diagnostics: [],
    valid: true,
    supersededPluginId: null,
  };
}

describe("plugin status projection", () => {
  it("projects declarations without exposing panel entry paths", () => {
    const status = initialPluginStatus(candidate(), undefined);

    expect(status).toMatchObject({
      id: "example-plugin",
      directoryName: "source-directory",
      rootPath: "/workspace/plugins/source-directory",
      valid: true,
      status: "discovered",
      displayName: "Candidate",
      icon: "candidate.svg",
      hasFailedReplacement: false,
      error: null,
    });
    expect(status.panels).toEqual([
      { id: "panel", title: "Candidate", placement: "view", icon: null },
    ]);
    expect(PluginStatusRecord.safeParse(status).success).toBe(true);
  });

  it.each([
    { recovery: "absent", built: false, contributions: "Candidate", metadata: "Candidate", failed: false },
    { recovery: "absent", built: true, contributions: "Built", metadata: "Built", failed: false },
    { recovery: "readable", built: false, contributions: "Recovered", metadata: "Candidate", failed: true },
    { recovery: "readable", built: true, contributions: "Recovered", metadata: "Built", failed: true },
    { recovery: "unreadable", built: false, contributions: "Current", metadata: "Candidate", failed: true },
    { recovery: "unreadable", built: true, contributions: "Current", metadata: "Built", failed: true },
  ] as const)("keeps contribution and metadata precedence for $recovery recovery, built=$built", (scenario) => {
    const source = candidate();
    const current = initialPluginStatus(candidate("Current"), undefined);
    const recovered = scenario.recovery === "absent"
      ? undefined
      : scenario.recovery === "unreadable" ? null : manifest("Recovered");
    const built = scenario.built ? { manifest: manifest("Built"), iconPath: "built.svg" } : undefined;
    const inputsBefore = structuredClone({ source, current, recovered, built });

    const next = projectPluginStatus(source, current, { status: "failed" }, recovered, built);

    expect(next.settings[0]?.label).toBe(scenario.contributions);
    expect(next.webApps[0]?.title).toBe(scenario.contributions);
    expect(next.panels[0]?.title).toBe(scenario.contributions);
    expect(next.commands[0]?.title).toBe(scenario.contributions);
    expect(next.displayName).toBe(scenario.metadata);
    expect(next.icon).toBe(scenario.built ? "built.svg" : "candidate.svg");
    expect(next.hasFailedReplacement).toBe(scenario.failed);
    expect(next.status).toBe("failed");
    expect(next.directoryName).toBe("source-directory");
    expect(next.rootPath).toBe("/workspace/plugins/source-directory");
    expect({ source, current, recovered, built }).toEqual(inputsBefore);
  });

  it("keeps explicit contribution patches while deriving settings and source identity", () => {
    const source = candidate();
    const current = initialPluginStatus(candidate("Current"), undefined);
    const next = projectPluginStatus(source, current, {
      valid: false,
      directoryName: "incorrect-directory",
      rootPath: "/incorrect-root",
      displayName: "Incorrect metadata",
      hasFailedReplacement: true,
      settings: [],
      webApps: [],
      panels: [],
      commands: [],
    }, undefined);

    expect(next).toMatchObject({
      valid: false,
      directoryName: "source-directory",
      rootPath: "/workspace/plugins/source-directory",
      displayName: "Candidate",
      hasFailedReplacement: false,
      webApps: [],
      panels: [],
      commands: [],
    });
    expect(next.settings[0]?.label).toBe("Candidate");
  });

  it("preserves current contributions and metadata for a synthetic candidate", () => {
    const current = initialPluginStatus(candidate("Current"), undefined);
    const source = { ...candidate(), manifest: null, iconPath: null, valid: false };
    const next = projectPluginStatus(source, current, { valid: true }, undefined);

    expect(next).toMatchObject({ valid: true, displayName: "Current", icon: "candidate.svg" });
    expect(next.settings).toEqual(current.settings);
    expect(next.webApps).toEqual(current.webApps);
    expect(next.panels).toEqual(current.panels);
    expect(next.commands).toEqual(current.commands);
  });

  it("keeps invalid status and recovery presence separate from manifest readability", () => {
    const source = { ...candidate(), manifest: null, valid: false };
    const initial = initialPluginStatus(source, null);
    const invalid = invalidPluginStatus(source, undefined);

    expect(initial).toMatchObject({ valid: false, status: "invalid", hasFailedReplacement: true, error: null });
    expect(invalid).toMatchObject({ valid: false, status: "invalid", hasFailedReplacement: false, error: null });
    expect(invalid.settings).toEqual([]);
    expect(invalid.panels).toEqual([]);
  });

  it("bounds discovery errors, diagnostics, and warnings for the bridge", () => {
    const source = { ...candidate(), valid: false, diagnostics: ["x".repeat(30_000), "another problem"] };
    const invalid = invalidPluginStatus(source, null);
    const next = projectPluginStatus(source, invalid, {
      diagnostics: ["d".repeat(30_000)],
      warnings: ["w".repeat(30_000)],
      error: pipelineError("build", "build-failed", "e".repeat(30_000)),
    }, null);

    expect(invalid.error).toMatchObject({ stage: "discovery", code: "invalid-plugin" });
    for (const message of [invalid.error!.message, ...invalid.diagnostics, ...next.diagnostics, ...next.warnings, next.error!.message]) {
      if (message === "another problem") continue;
      expect(message).toContain("characters elided");
      expect(message.length).toBeLessThanOrEqual(8_000);
    }
    expect(PluginStatusRecord.safeParse(invalid).success).toBe(true);
    expect(PluginStatusRecord.safeParse(next).success).toBe(true);
    expect(pipelineError("build", "empty-error", "").message).toBe("(no error detail)");
  });

  it("copies an inherited or replacement error and permits explicit clearing", () => {
    const source = candidate();
    const current = initialPluginStatus(source, undefined);
    current.error = pipelineError("runtime", "old-error", "Old error.");
    const inherited = projectPluginStatus(source, current, {}, undefined);
    const replacement = pipelineError("runtime", "new-error", "New error.");
    const replaced = projectPluginStatus(source, current, { error: replacement }, undefined);

    expect(inherited.error).toEqual(current.error);
    expect(inherited.error).not.toBe(current.error);
    expect(replaced.error).toEqual(replacement);
    expect(replaced.error).not.toBe(replacement);
    expect(projectPluginStatus(source, current, { error: null }, undefined).error).toBeNull();
  });

  it("isolates mutable status records returned to callers", () => {
    const status = initialPluginStatus(candidate(), undefined);
    status.error = pipelineError("runtime", "runtime-failed", "Runtime failed.");
    status.diagnostics = ["Diagnostic"];
    status.warnings = ["Warning"];
    const before = structuredClone(status);
    const copy = cloneStatus(status);

    copy.settings[0]!.label = "Changed setting";
    copy.webApps[0]!.title = "Changed app";
    copy.panels[0]!.title = "Changed panel";
    copy.commands[0]!.title = "Changed command";
    copy.error!.message = "Changed error";
    copy.diagnostics.push("Changed diagnostic");
    copy.warnings.push("Changed warning");

    expect(status).toEqual(before);
  });
});
