import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveEffectivePolicy } from "@dohc/security-contract/effective-policy";
import type { TextFileSnapshot } from "@dohc/workspace-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nativeTmpdir } from "./testTemp";
import {
  readWorkspaceEnginePolicy,
  resolveEngineSearchPolicy,
  type WorkspaceEnginePolicySnapshot,
} from "./workspaceEnginePolicyFile";

function snapshot(
  overrides: Partial<WorkspaceEnginePolicySnapshot> = {},
): WorkspaceEnginePolicySnapshot {
  return { filesPolicy: null, visibilityPolicy: null, errors: [], ...overrides };
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
  // Search FAILS CLOSED on policy errors (capture stays floor-only per
  // WS-F): resolveEffectivePolicy defaults tracked paths to searchable, so
  // null rules from an unparseable file would WIDEN search.
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
    root = await mkdtemp(join(nativeTmpdir(), "dohc-engine-policy-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("a malformed files.toml on disk blocks search instead of widening it", async () => {
    await readWorkspaceEnginePolicy(root); // bootstraps .dohc
    await writeFile(join(root, ".dohc", "files.toml"), "this is [[ not toml");
    const policy = await readWorkspaceEnginePolicy(root);
    expect(policy.errors.length).toBeGreaterThan(0);
    expect(resolveEngineSearchPolicy(policy).kind).toBe("blocked");
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
