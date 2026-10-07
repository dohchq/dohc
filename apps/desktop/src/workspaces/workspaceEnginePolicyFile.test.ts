import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveEffectivePolicy } from "@dohc/security-contract/effective-policy";
import type { TextFileSnapshot } from "@dohc/workspace-contracts/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestScratch } from "./testTemp";
import {
  historyExcludesSubtree,
  readWorkspaceEnginePolicy,
  resolveEngineSearchPolicy,
  type WorkspaceEnginePolicySnapshot,
} from "./workspaceEnginePolicyFile";

describe("historyExcludesSubtree", () => {
  const excludes = (rules: Array<{ path: string; tracked?: boolean }>, folder: string, errors: string[] = []) =>
    historyExcludesSubtree(snapshot({ filesPolicy: rules, errors }), folder);

  it("proves a folder excluded only by a rule covering its whole subtree", () => {
    expect(excludes([{ path: "build/**", tracked: false }], "build")).toBe(true);
    expect(excludes([{ path: "build/**", tracked: false }], "build/cache")).toBe(true);
    expect(excludes([{ path: "*/cache/**", tracked: false }], "app/cache")).toBe(true);
    expect(excludes([{ path: "**", tracked: false }], "anything")).toBe(true);
    // A rule for some depth, or for some names, leaves the rest tracked.
    expect(excludes([{ path: "build/*", tracked: false }], "build")).toBe(false);
    expect(excludes([{ path: "build/**/x", tracked: false }], "build")).toBe(false);
    expect(excludes([{ path: "build/cache/**", tracked: false }], "build")).toBe(false);
    expect(excludes([], "build")).toBe(false);
  });

  it("keeps walking when a later rule could track something inside", () => {
    expect(excludes([{ path: "build/**", tracked: false }, { path: "build/keep.md", tracked: true }], "build")).toBe(false);
    expect(excludes([{ path: "build/**", tracked: false }, { path: "*/notes/**", tracked: true }], "build")).toBe(false);
    expect(excludes([{ path: "build/**", tracked: false }, { path: "**", tracked: true }], "build")).toBe(false);
    // Searchable-only rules and rules elsewhere do not reach the folder.
    expect(excludes([{ path: "build/**", tracked: false }, { path: "build/**" }, { path: "docs/**", tracked: true }], "build")).toBe(true);
    // A later exclusion of the whole subtree takes the earlier inclusion back.
    expect(excludes([{ path: "build/keep.md", tracked: true }, { path: "build/**", tracked: false }], "build")).toBe(true);
  });

  it("proves nothing from a policy that did not parse", () => {
    expect(excludes([{ path: "build/**", tracked: false }], "build", ["files.toml: invalid TOML"])).toBe(false);
  });
});

function snapshot(
  overrides: Partial<WorkspaceEnginePolicySnapshot> = {},
): WorkspaceEnginePolicySnapshot {
  return { filesPolicy: null, visibilityPolicy: null, errors: [], unreadable: [], ...overrides };
}

function fileSnapshot(path: string): TextFileSnapshot {
  return {
    objectId: "object-1",
    versionId: "main",
    path,
    text: "body\n",
    updatedAtMs: 1,
    latestMomentId: "moment-1",
    metadata: { origin: "local-file" },
  };
}

describe("resolveEngineSearchPolicy", () => {
  // Search fails closed on policy errors (capture stays floor-only per
  // WS-F): resolveEffectivePolicy defaults tracked paths to searchable, so
  // null rules from an unparseable file would widen search.
  it("blocks search outright when the policy snapshot carries errors", () => {
    const decision = resolveEngineSearchPolicy(
      snapshot({ errors: ["files.toml: bad TOML"] }),
    );
    expect(decision).toEqual({ kind: "blocked", message: "files.toml: bad TOML" });
  });

  it("blocks even when the other policy file parsed cleanly", () => {
    const decision = resolveEngineSearchPolicy(
      snapshot({
        filesPolicy: [{ path: "docs/**", searchable: false }],
        errors: ["visibility.toml: bad TOML"],
      }),
    );
    expect(decision.kind).toBe("blocked");
  });

  it("joins multiple errors into the blocked message", () => {
    const decision = resolveEngineSearchPolicy(
      snapshot({ errors: ["files.toml: bad", "visibility.toml: worse"] }),
    );
    expect(decision).toEqual({
      kind: "blocked",
      message: "files.toml: bad; visibility.toml: worse",
    });
  });

  it("resolves searchability from clean policies (searchable/hidden/secret floor)", () => {
    const decision = resolveEngineSearchPolicy(
      snapshot({
        filesPolicy: [{ path: "docs/**", searchable: false }],
        visibilityPolicy: [{ path: "private/**", visibility: "hidden" }],
      }),
    );
    expect(decision.kind).toBe("search");
    if (decision.kind !== "search") return;
    expect(decision.fileVisibility(fileSnapshot("notes/today.md"))).toEqual({
      searchable: true,
    });
    expect(decision.fileVisibility(fileSnapshot("docs/plan.md"))).toEqual({
      searchable: false,
      reason: "ignored",
    });
    expect(decision.fileVisibility(fileSnapshot("private/plan.md"))).toEqual({
      searchable: false,
      reason: "ignored",
    });
    // The secret floor can never be widened by policy.
    expect(decision.fileVisibility(fileSnapshot(".env"))).toEqual({
      searchable: false,
      reason: "secret",
    });
  });

  it("defaults tracked paths to searchable when no policy files exist (no errors)", () => {
    const decision = resolveEngineSearchPolicy(snapshot());
    expect(decision.kind).toBe("search");
    if (decision.kind !== "search") return;
    expect(decision.fileVisibility(fileSnapshot("notes/today.md"))).toEqual({
      searchable: true,
    });
  });
});

describe("readWorkspaceEnginePolicy + resolveEngineSearchPolicy (fail closed end to end)", () => {
  let root: string;

  beforeEach(async () => {
    root = await createTestScratch("dohc-engine-policy-");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("a malformed files.toml on disk blocks search instead of widening it", async () => {
    await readWorkspaceEnginePolicy(root); // bootstraps .dohc
    await writeFile(join(root, ".dohc", "files.toml"), "this is [[ not toml");
    const policy = await readWorkspaceEnginePolicy(root);
    expect(policy.errors.length).toBeGreaterThan(0);
    expect(policy.unreadable).toEqual([".dohc/files.toml"]);
    expect(resolveEngineSearchPolicy(policy).kind).toBe("blocked");
  });

  it("names each policy file it could not read, and none when both read", async () => {
    await readWorkspaceEnginePolicy(root); // bootstraps .dohc
    expect((await readWorkspaceEnginePolicy(root)).unreadable).toEqual([]);
    await writeFile(join(root, ".dohc", "visibility.toml"), "this is [[ not toml");
    expect((await readWorkspaceEnginePolicy(root)).unreadable).toEqual([".dohc/visibility.toml"]);
    await writeFile(join(root, ".dohc", "files.toml"), "this is [[ not toml");
    expect((await readWorkspaceEnginePolicy(root)).unreadable).toEqual([".dohc/files.toml", ".dohc/visibility.toml"]);
  });

  it("names the .dohc folder when it is not a real folder", async () => {
    await writeFile(join(root, ".dohc"), "not a folder");
    const policy = await readWorkspaceEnginePolicy(root);
    expect(policy.errors).toHaveLength(1);
    expect(policy.unreadable).toEqual([".dohc"]);
  });

  it("a clean files.toml on disk resolves to a searching decision", async () => {
    await readWorkspaceEnginePolicy(root); // bootstraps .dohc
    await writeFile(
      join(root, ".dohc", "files.toml"),
      '[[rule]]\npath = "docs/**"\nsearchable = false\n',
    );
    const policy = await readWorkspaceEnginePolicy(root);
    expect(policy.errors).toEqual([]);
    const decision = resolveEngineSearchPolicy(policy);
    expect(decision.kind).toBe("search");
    if (decision.kind !== "search") return;
    expect(decision.fileVisibility(fileSnapshot("docs/plan.md")).searchable).toBe(false);
    expect(decision.fileVisibility(fileSnapshot("notes/a.md")).searchable).toBe(true);
  });
});
