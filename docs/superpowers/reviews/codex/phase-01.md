OpenAI Codex v0.130.0
--------
workdir: /home/ice/dev/dohc
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: high
reasoning summaries: none
session id: 019eb09e-49a3-71f0-b923-ca801a546c81
--------
user
commit 67d692f
warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
exec
/bin/bash -lc 'git status --short && git rev-parse --show-toplevel && git show --stat --oneline --decorate --no-renames 67d692f' in /home/ice/dev/dohc
 succeeded in 0ms:
?? docs/superpowers/reviews/codex/phase-01.md
/home/ice/dev/dohc
67d692f (HEAD -> claude/desktop-local-first-cloud-sync) phase1: Add local-first workspace core contract
 ...desktop-local-first-cloud-sync.execution-log.md | 25 ++++++
 packages/workspace-core/package.json               | 17 ++++
 packages/workspace-core/src/changeSet.test.ts      | 84 ++++++++++++++++++
 packages/workspace-core/src/changeSet.ts           | 57 +++++++++++++
 packages/workspace-core/src/conflicts.ts           | 13 +++
 packages/workspace-core/src/index.ts               |  5 ++
 packages/workspace-core/src/metadata.ts            | 36 ++++++++
 packages/workspace-core/src/paths.test.ts          | 99 ++++++++++++++++++++++
 packages/workspace-core/src/paths.ts               | 66 +++++++++++++++
 packages/workspace-core/src/workspaceMode.test.ts  | 32 +++++++
 packages/workspace-core/src/workspaceMode.ts       | 16 ++++
 packages/workspace-core/tsconfig.json              |  4 +
 pnpm-lock.yaml                                     | 12 +++
 13 files changed, 466 insertions(+)

exec
/bin/bash -lc 'git show --no-ext-diff --unified=80 --no-renames 67d692f -- packages/workspace-core/src packages/workspace-core/package.json packages/workspace-core/tsconfig.json pnpm-lock.yaml' in /home/ice/dev/dohc
 succeeded in 0ms:
commit 67d692f36d360eec6d69e58bd4a21f097ffa0d41
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 16:20:09 2026 +0800

    phase1: Add local-first workspace core contract
    
    Workspace modes (personal=local-first, shared=cloud-first-local-copy),
    manifest/file-record metadata, path validation (traversal incl. double-
    encoded variants, reserved .dohc, app/database classification), change
    sets with liberal review policy (5 boundary crossings), human-readable
    conflict summaries. 31 tests, RED recorded before implementation,
    verifier fan-out passed (test-quality worktree + claimed-vs-actual).
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/packages/workspace-core/package.json b/packages/workspace-core/package.json
new file mode 100644
index 0000000..dcb85c5
--- /dev/null
+++ b/packages/workspace-core/package.json
@@ -0,0 +1,17 @@
+{
+  "name": "@dohc/workspace-core",
+  "private": true,
+  "type": "module",
+  "exports": {
+    ".": "./src/index.ts"
+  },
+  "scripts": {
+    "test": "vitest run",
+    "typecheck": "tsc --noEmit"
+  },
+  "devDependencies": {
+    "@types/node": "^22.19.19",
+    "typescript": "^5.9.3",
+    "vitest": "^2.1.9"
+  }
+}
diff --git a/packages/workspace-core/src/changeSet.test.ts b/packages/workspace-core/src/changeSet.test.ts
new file mode 100644
index 0000000..6e6834d
--- /dev/null
+++ b/packages/workspace-core/src/changeSet.test.ts
@@ -0,0 +1,84 @@
+import { describe, expect, it } from "vitest";
+import {
+  addBoundaryCrossing,
+  addFileChanges,
+  createChangeSet,
+  requiresReview,
+  type BoundaryCrossing,
+} from "./changeSet";
+import { describeConflict } from "./conflicts";
+
+const agentAuthor = {
+  kind: "agent" as const,
+  agentId: "codex-local",
+  onBehalfOf: "user-1",
+};
+
+describe("change set grouping", () => {
+  it("groups one agent run editing many files into a single change set", () => {
+    const set = createChangeSet({
+      kind: "agent-run",
+      author: agentAuthor,
+      summary: "Imported transactions and built ledger app",
+    });
+    const files = Array.from({ length: 18 }, (_, i) => ({
+      path: `finance/.apps/ledger/src/file-${i}.tsx`,
+      operation: "write" as const,
+    }));
+    const grouped = addFileChanges(set, files);
+    expect(grouped.files).toHaveLength(18);
+    expect(grouped.kind).toBe("agent-run");
+    expect(grouped.author).toEqual(agentAuthor);
+  });
+});
+
+describe("review requirements", () => {
+  it("does not require approval for normal allowed edits", () => {
+    const set = addFileChanges(
+      createChangeSet({
+        kind: "user-edit",
+        author: { kind: "user", userId: "user-1" },
+        summary: "Edited notes",
+      }),
+      [{ path: "notes/today.md", operation: "write" }],
+    );
+    expect(requiresReview(set)).toBe(false);
+  });
+
+  const crossings: BoundaryCrossing[] = [
+    "public-share",
+    "permission-change",
+    "bulk-delete",
+    "app-trust",
+    "private-to-shared",
+  ];
+
+  for (const crossing of crossings) {
+    it(`requires review for boundary crossing: ${crossing}`, () => {
+      const set = addBoundaryCrossing(
+        createChangeSet({
+          kind: "agent-run",
+          author: agentAuthor,
+          summary: "Crossed a boundary",
+        }),
+        crossing,
+      );
+      expect(requiresReview(set)).toBe(true);
+      expect(set.boundaryCrossings).toContain(crossing);
+    });
+  }
+});
+
+describe("conflict summaries", () => {
+  it("produces a human-readable summary without Git conflict markers", () => {
+    const summary = describeConflict({
+      path: "notes/plan.md",
+      localDescription: "you reworded the intro",
+      remoteDescription: "Maya added a budget section",
+    });
+    expect(summary).toContain("notes/plan.md");
+    expect(summary).toContain("you reworded the intro");
+    expect(summary).toContain("Maya added a budget section");
+    expect(summary).not.toMatch(/<{7}|>{7}|={7}/);
+  });
+});
diff --git a/packages/workspace-core/src/changeSet.ts b/packages/workspace-core/src/changeSet.ts
new file mode 100644
index 0000000..5773eaf
--- /dev/null
+++ b/packages/workspace-core/src/changeSet.ts
@@ -0,0 +1,57 @@
+export type ChangeSetKind =
+  | "user-edit"
+  | "agent-run"
+  | "import"
+  | "sync"
+  | "app-build";
+
+export type BoundaryCrossing =
+  | "public-share"
+  | "external-export"
+  | "permission-change"
+  | "bulk-delete"
+  | "app-trust"
+  | "private-to-shared"
+  | "unmergeable-overwrite";
+
+export type ChangeAuthor =
+  | { kind: "user"; userId: string }
+  | { kind: "agent"; agentId: string; onBehalfOf: string };
+
+export interface FileChange {
+  path: string;
+  operation: "write" | "delete" | "rename";
+}
+
+export interface ChangeSet {
+  kind: ChangeSetKind;
+  author: ChangeAuthor;
+  summary: string;
+  files: FileChange[];
+  boundaryCrossings: BoundaryCrossing[];
+}
+
+export function createChangeSet(input: {
+  kind: ChangeSetKind;
+  author: ChangeAuthor;
+  summary: string;
+}): ChangeSet {
+  return { ...input, files: [], boundaryCrossings: [] };
+}
+
+export function addFileChanges(set: ChangeSet, files: FileChange[]): ChangeSet {
+  return { ...set, files: [...set.files, ...files] };
+}
+
+export function addBoundaryCrossing(
+  set: ChangeSet,
+  crossing: BoundaryCrossing,
+): ChangeSet {
+  return { ...set, boundaryCrossings: [...set.boundaryCrossings, crossing] };
+}
+
+// Liberal by default: ordinary edits sync freely; only genuine boundary
+// crossings need a human to look.
+export function requiresReview(set: ChangeSet): boolean {
+  return set.boundaryCrossings.length > 0;
+}
diff --git a/packages/workspace-core/src/conflicts.ts b/packages/workspace-core/src/conflicts.ts
new file mode 100644
index 0000000..7c24e46
--- /dev/null
+++ b/packages/workspace-core/src/conflicts.ts
@@ -0,0 +1,13 @@
+export interface ConflictInput {
+  path: string;
+  localDescription: string;
+  remoteDescription: string;
+}
+
+// Conflicts read like a sentence, never like Git markers.
+export function describeConflict(input: ConflictInput): string {
+  return (
+    `Both sides changed ${input.path}: ${input.localDescription}, ` +
+    `while ${input.remoteDescription}. Both versions are kept until you choose.`
+  );
+}
diff --git a/packages/workspace-core/src/index.ts b/packages/workspace-core/src/index.ts
new file mode 100644
index 0000000..7d6db61
--- /dev/null
+++ b/packages/workspace-core/src/index.ts
@@ -0,0 +1,5 @@
+export * from "./workspaceMode";
+export * from "./metadata";
+export * from "./paths";
+export * from "./changeSet";
+export * from "./conflicts";
diff --git a/packages/workspace-core/src/metadata.ts b/packages/workspace-core/src/metadata.ts
new file mode 100644
index 0000000..daf60cd
--- /dev/null
+++ b/packages/workspace-core/src/metadata.ts
@@ -0,0 +1,36 @@
+import {
+  defaultWorkspaceMode,
+  type WorkspaceKind,
+  type WorkspaceMode,
+} from "./workspaceMode";
+
+// Mode lives on the workspace manifest and nowhere else: a workspace is
+// local-first, cloud-first, or cloud-only as a whole, never per file.
+export interface WorkspaceManifest {
+  version: 1;
+  workspaceId: string;
+  mode: WorkspaceMode;
+  kind: WorkspaceKind;
+}
+
+export function createWorkspaceManifest(input: {
+  workspaceId: string;
+  kind: WorkspaceKind;
+  mode?: WorkspaceMode;
+}): WorkspaceManifest {
+  return {
+    version: 1,
+    workspaceId: input.workspaceId,
+    kind: input.kind,
+    mode: input.mode ?? defaultWorkspaceMode(input.kind),
+  };
+}
+
+export interface FileRecord {
+  path: string;
+  contentHash: string;
+}
+
+export function createFileRecord(input: FileRecord): FileRecord {
+  return { path: input.path, contentHash: input.contentHash };
+}
diff --git a/packages/workspace-core/src/paths.test.ts b/packages/workspace-core/src/paths.test.ts
new file mode 100644
index 0000000..35372d9
--- /dev/null
+++ b/packages/workspace-core/src/paths.test.ts
@@ -0,0 +1,99 @@
+import { describe, expect, it } from "vitest";
+import {
+  classifyPath,
+  defaultWorkspaceRoot,
+  isReservedPath,
+  validateAttachedFolder,
+  validateUserWritePath,
+} from "./paths";
+
+describe("workspace roots", () => {
+  it("suggests ~/dohc as the default root", () => {
+    expect(defaultWorkspaceRoot("/home/ice")).toBe("/home/ice/dohc");
+  });
+
+  it("allows attaching arbitrary absolute folders", () => {
+    expect(validateAttachedFolder("/home/ice/projects/notes").ok).toBe(true);
+    expect(validateAttachedFolder("/mnt/data/research").ok).toBe(true);
+  });
+
+  it("rejects relative paths as attached folders", () => {
+    expect(validateAttachedFolder("projects/notes").ok).toBe(false);
+  });
+});
+
+describe("reserved paths", () => {
+  it("reserves .dohc/manifest.json and the .dohc subtree", () => {
+    expect(isReservedPath(".dohc/manifest.json")).toBe(true);
+    expect(isReservedPath(".dohc/history/0001.json")).toBe(true);
+    expect(isReservedPath("notes/today.md")).toBe(false);
+  });
+
+  it("rejects user writes into reserved space", () => {
+    const result = validateUserWritePath(".dohc/manifest.json");
+    expect(result.ok).toBe(false);
+    if (!result.ok) expect(result.reason).toBe("reserved");
+  });
+});
+
+describe("path traversal", () => {
+  const traversals = [
+    "../escape.md",
+    "notes/../../etc/passwd",
+    "%2e%2e/sneak.md",
+    "..\\windows\\system32",
+    "a/%2E%2E/b",
+    "%252e%252e/double-encoded.md",
+    "..%2fescape.md",
+    "..%5cwindows",
+  ];
+
+  for (const candidate of traversals) {
+    it(`rejects traversal: ${JSON.stringify(candidate)}`, () => {
+      const result = validateUserWritePath(candidate);
+      expect(result.ok).toBe(false);
+      if (!result.ok) expect(result.reason).toBe("traversal");
+    });
+  }
+
+  it("rejects absolute paths inside a workspace", () => {
+    const result = validateUserWritePath("/etc/passwd");
+    expect(result.ok).toBe(false);
+    if (!result.ok) expect(result.reason).toBe("absolute");
+  });
+
+  it("rejects null bytes", () => {
+    const result = validateUserWritePath("notes/a\0b.md");
+    expect(result.ok).toBe(false);
+    if (!result.ok) expect(result.reason).toBe("invalid");
+  });
+
+  it("accepts and normalizes ordinary nested paths", () => {
+    const result = validateUserWritePath("finance/./reports/q1.md");
+    expect(result.ok).toBe(true);
+    if (result.ok) expect(result.normalized).toBe("finance/reports/q1.md");
+  });
+});
+
+describe("path classification", () => {
+  it("treats .apps/<name>/app.json as visible app source", () => {
+    expect(classifyPath("finance/.apps/ledger/app.json")).toEqual({
+      kind: "app-source",
+      appName: "ledger",
+    });
+    expect(classifyPath(".apps/tracker/src/App.tsx")).toEqual({
+      kind: "app-source",
+      appName: "tracker",
+    });
+  });
+
+  it("treats .sqlite, .sqlite3, and .db files as visible databases", () => {
+    expect(classifyPath("finance/wallet.sqlite")).toEqual({ kind: "database" });
+    expect(classifyPath("data/cache.sqlite3")).toEqual({ kind: "database" });
+    expect(classifyPath("archive/old.db")).toEqual({ kind: "database" });
+  });
+
+  it("classifies everything else as a plain file", () => {
+    expect(classifyPath("notes/today.md")).toEqual({ kind: "file" });
+  });
+});
diff --git a/packages/workspace-core/src/paths.ts b/packages/workspace-core/src/paths.ts
new file mode 100644
index 0000000..c9cf9cb
--- /dev/null
+++ b/packages/workspace-core/src/paths.ts
@@ -0,0 +1,66 @@
+export function defaultWorkspaceRoot(homeDir: string): string {
+  return `${homeDir.replace(/\/+$/, "")}/dohc`;
+}
+
+export type FolderValidation = { ok: true } | { ok: false; reason: string };
+
+export function validateAttachedFolder(path: string): FolderValidation {
+  if (!path.startsWith("/")) {
+    return { ok: false, reason: "attached folders must be absolute paths" };
+  }
+  return { ok: true };
+}
+
+const RESERVED_PREFIX = ".dohc/";
+
+export function isReservedPath(relativePath: string): boolean {
+  return relativePath === ".dohc" || relativePath.startsWith(RESERVED_PREFIX);
+}
+
+export type WritePathValidation =
+  | { ok: true; normalized: string }
+  | { ok: false; reason: "traversal" | "absolute" | "reserved" | "invalid" };
+
+export function validateUserWritePath(relativePath: string): WritePathValidation {
+  if (relativePath.includes("\0")) return { ok: false, reason: "invalid" };
+  if (relativePath.startsWith("/")) return { ok: false, reason: "absolute" };
+  // Percent-encoded dots/separators are traversal in disguise; decode until
+  // stable so double-encoding (%252e -> %2e -> .) cannot slip through.
+  let decoded = relativePath;
+  for (;;) {
+    const next = decoded
+      .replace(/%25/gi, "%")
+      .replace(/%2e/gi, ".")
+      .replace(/%2f/gi, "/")
+      .replace(/%5c/gi, "\\");
+    if (next === decoded) break;
+    decoded = next;
+  }
+  const segments = decoded.replaceAll("\\", "/").split("/");
+  if (segments.includes("..")) return { ok: false, reason: "traversal" };
+  const normalized = segments
+    .filter((segment) => segment !== "" && segment !== ".")
+    .join("/");
+  if (normalized.length === 0) return { ok: false, reason: "invalid" };
+  if (isReservedPath(normalized)) return { ok: false, reason: "reserved" };
+  return { ok: true, normalized };
+}
+
+export type PathClassification =
+  | { kind: "app-source"; appName: string }
+  | { kind: "database" }
+  | { kind: "file" };
+
+const DATABASE_EXTENSIONS = [".sqlite", ".sqlite3", ".db"];
+
+export function classifyPath(relativePath: string): PathClassification {
+  const segments = relativePath.split("/");
+  const appsIndex = segments.indexOf(".apps");
+  const appName = appsIndex === -1 ? undefined : segments[appsIndex + 1];
+  if (appName) return { kind: "app-source", appName };
+  const lower = relativePath.toLowerCase();
+  if (DATABASE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
+    return { kind: "database" };
+  }
+  return { kind: "file" };
+}
diff --git a/packages/workspace-core/src/workspaceMode.test.ts b/packages/workspace-core/src/workspaceMode.test.ts
new file mode 100644
index 0000000..a55e893
--- /dev/null
+++ b/packages/workspace-core/src/workspaceMode.test.ts
@@ -0,0 +1,32 @@
+import { describe, expect, it } from "vitest";
+import { createFileRecord, createWorkspaceManifest } from "./metadata";
+import { defaultWorkspaceMode } from "./workspaceMode";
+
+describe("workspace modes", () => {
+  it("defaults personal workspaces to local-first", () => {
+    expect(defaultWorkspaceMode("personal")).toBe("local-first");
+  });
+
+  it("defaults shared workspaces to cloud-first with a local copy", () => {
+    expect(defaultWorkspaceMode("shared")).toBe("cloud-first-local-copy");
+  });
+
+  it("defaults cloud-only workspaces to cloud-only", () => {
+    expect(defaultWorkspaceMode("cloud-only")).toBe("cloud-only");
+  });
+
+  it("stores mode on the workspace manifest, never on file records", () => {
+    const manifest = createWorkspaceManifest({
+      workspaceId: "ws-1",
+      kind: "shared",
+    });
+    expect(manifest.mode).toBe("cloud-first-local-copy");
+    expect(manifest.version).toBe(1);
+
+    const record = createFileRecord({
+      path: "notes/today.md",
+      contentHash: "abc123",
+    });
+    expect("mode" in record).toBe(false);
+  });
+});
diff --git a/packages/workspace-core/src/workspaceMode.ts b/packages/workspace-core/src/workspaceMode.ts
new file mode 100644
index 0000000..c686bc7
--- /dev/null
+++ b/packages/workspace-core/src/workspaceMode.ts
@@ -0,0 +1,16 @@
+export type WorkspaceMode =
+  | "local-first"
+  | "cloud-first-local-copy"
+  | "cloud-only";
+
+export type WorkspaceKind = "personal" | "shared" | "cloud-only";
+
+const DEFAULT_MODE_BY_KIND: Record<WorkspaceKind, WorkspaceMode> = {
+  personal: "local-first",
+  shared: "cloud-first-local-copy",
+  "cloud-only": "cloud-only",
+};
+
+export function defaultWorkspaceMode(kind: WorkspaceKind): WorkspaceMode {
+  return DEFAULT_MODE_BY_KIND[kind];
+}
diff --git a/packages/workspace-core/tsconfig.json b/packages/workspace-core/tsconfig.json
new file mode 100644
index 0000000..9e25e6e
--- /dev/null
+++ b/packages/workspace-core/tsconfig.json
@@ -0,0 +1,4 @@
+{
+  "extends": "../../tsconfig.base.json",
+  "include": ["src/**/*.ts"]
+}
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 1c414a8..05a666f 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -177,160 +177,172 @@ importers:
       '@types/jsdom':
         specifier: 28.0.3
         version: 28.0.3
       '@types/node':
         specifier: ^22.13.10
         version: 22.19.19
       '@types/prismjs':
         specifier: ^1.26.6
         version: 1.26.6
       '@types/react':
         specifier: ^19.2.14
         version: 19.2.15
       '@types/react-dom':
         specifier: ^19.2.0
         version: 19.2.3(@types/react@19.2.15)
       '@vitejs/plugin-react':
         specifier: ^6.0.1
         version: 6.0.2(vite@8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3))
       concurrently:
         specifier: ^9.1.0
         version: 9.2.1
       convex-test:
         specifier: ^0.0.51
         version: 0.0.51(convex@1.39.1(react@19.2.6))
       typescript:
         specifier: ^5.7.2
         version: 5.9.3
       vite:
         specifier: ^8.0.10
         version: 8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
       vitest:
         specifier: ^2.1.9
         version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
 
   packages/brand:
     devDependencies:
       '@types/react':
         specifier: ^19.2.14
         version: 19.2.15
       react:
         specifier: ^19.2.5
         version: 19.2.6
 
   packages/config: {}
 
   packages/workspace-contracts:
     dependencies:
       zod:
         specifier: ^3.23.8
         version: 3.25.76
     devDependencies:
       typescript:
         specifier: ^5.7.2
         version: 5.9.3
       vitest:
         specifier: ^2.1.9
         version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
 
   packages/workspace-convex-compat:
     dependencies:
       '@dohc/workspace-contracts':
         specifier: workspace:*
         version: link:../workspace-contracts
       convex:
         specifier: ^1.37.0
         version: 1.39.1(react@19.2.6)
       convex-test:
         specifier: ^0.0.51
         version: 0.0.51(convex@1.39.1(react@19.2.6))
     devDependencies:
       typescript:
         specifier: ^5.7.2
         version: 5.9.3
       vite:
         specifier: ^8.0.10
         version: 8.0.14(@types/node@22.19.19)(esbuild@0.28.0)(jiti@2.7.0)(tsx@4.22.3)
       vitest:
         specifier: ^2.1.9
         version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
 
+  packages/workspace-core:
+    devDependencies:
+      '@types/node':
+        specifier: ^22.19.19
+        version: 22.19.19
+      typescript:
+        specifier: ^5.9.3
+        version: 5.9.3
+      vitest:
+        specifier: ^2.1.9
+        version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
+
   packages/workspace-fs:
     dependencies:
       '@dohc/workspace-contracts':
         specifier: workspace:*
         version: link:../workspace-contracts
     devDependencies:
       '@dohc/workspace-api':
         specifier: workspace:*
         version: link:../../services/workspace-api
       '@types/node':
         specifier: ^22.19.19
         version: 22.19.19
       tsx:
         specifier: ^4.22.3
         version: 4.22.3
       typescript:
         specifier: ^5.9.3
         version: 5.9.3
       vitest:
         specifier: ^2.1.9
         version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
 
   packages/workspace-postgres:
     dependencies:
       '@dohc/workspace-contracts':
         specifier: workspace:*
         version: link:../workspace-contracts
       drizzle-orm:
         specifier: ^0.45.2
         version: 0.45.2(@opentelemetry/api@1.9.1)(@types/pg@8.20.0)(pg@8.21.0)
       pg:
         specifier: ^8.13.1
         version: 8.21.0
       zod:
         specifier: ^3.23.8
         version: 3.25.76
     devDependencies:
       '@types/pg':
         specifier: ^8.11.11
         version: 8.20.0
       typescript:
         specifier: ^5.7.2
         version: 5.9.3
       vitest:
         specifier: ^2.1.9
         version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
 
   services/agent-sandbox:
     dependencies:
       '@dohc/workspace-contracts':
         specifier: workspace:*
         version: link:../../packages/workspace-contracts
       '@dohc/workspace-fs':
         specifier: workspace:*
         version: link:../../packages/workspace-fs
     devDependencies:
       '@types/node':
         specifier: ^22.19.19
         version: 22.19.19
       typescript:
         specifier: ^5.9.3
         version: 5.9.3
       vitest:
         specifier: ^2.1.9
         version: 2.1.9(@edge-runtime/vm@4.0.4)(@types/node@22.19.19)(jsdom@29.1.1)(lightningcss@1.32.0)
 
   services/app-tester:
     devDependencies:
       '@playwright/test':
         specifier: ^1.60.0
         version: 1.60.0
       '@types/node':
         specifier: ^22.19.19
         version: 22.19.19
       tsx:
         specifier: ^4.22.3
         version: 4.22.3
       typescript:
         specifier: ^5.9.3
         version: 5.9.3

exec
/bin/bash -lc "ls -la && find . -maxdepth 3 -name package.json -not -path './node_modules/*' | sort | xargs -I{} sh -c 'echo --- {}; sed -n \"1,220p\" {}'" in /home/ice/dev/dohc
 succeeded in 238ms:
{
  "name": "@dohc/web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -n vite,convex -c green,yellow --kill-others-on-fail \"pnpm dev:vite\" \"pnpm convex:dev\"",
    "dev:vite": "vite dev --port 3000",
    "convex:dev": "npx convex dev",
    "convex:deploy": "npx convex deploy",
    "build": "vite build",
    "start": "node .output/server/index.mjs",
    "preview": "pnpm build && pnpm start",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "eval": "vitest run src/eval/live.test.ts",
    "lint": "tsc --noEmit",
    "reset:dev": "node ../../scripts/reset-dev-data.mjs",
    "reset:onboarding": "npx convex run internal.devReset.wipeWorkspace '{\"workspaceId\":\"user_01KQHA425W6TSH7CYBM0FAAZEH\",\"confirm\":\"WIPE\"}'",
    "migrate:skills": "npx convex run internal.skillsMigration._migrateLegacyPaths '{\"workspaceId\":\"user_01KQHA425W6TSH7CYBM0FAAZEH\"}'"
  },
  "dependencies": {
    "@ai-sdk/anthropic": "3.0.77",
    "@ai-sdk/openai": "3.0.67",
    "@ai-sdk/provider": "3.0.10",
    "@convex-dev/agent": "0.6.1",
    "@convex-dev/workos-authkit": "^0.2.2",
    "@dohc/brand": "workspace:*",
    "@emoji-mart/data": "^1.2.1",
    "@emoji-mart/react": "^1.1.1",
    "@fontsource/ibm-plex-mono": "^5.2.7",
    "@hocuspocus/provider": "^4.1.0",
    "@tailwindcss/vite": "^4.2.4",
    "@tanstack/react-router": "^1.169.0",
    "@tanstack/react-start": "^1.167.53",
    "@tiptap/core": "^3.23.6",
    "@tiptap/extension-code-block-lowlight": "^3.23.6",
    "@tiptap/extension-collaboration": "^3.23.6",
    "@tiptap/extension-collaboration-caret": "^3.23.6",
    "@tiptap/extension-table": "^3.23.6",
    "@tiptap/extensions": "^3.23.6",
    "@tiptap/markdown": "^3.23.6",
    "@tiptap/pm": "^3.23.6",
    "@tiptap/react": "^3.23.6",
    "@tiptap/starter-kit": "^3.23.6",
    "@workos-inc/node": "^8.0.0",
    "@workos/authkit-session": "^0.5.1",
    "@workos/authkit-tanstack-react-start": "^0.7.0",
    "ai": "6.0.180",
    "convex": "^1.37.0",
    "d3-force-3d": "^3.0.6",
    "emoji-mart": "^5.6.0",
    "esbuild": "^0.28.0",
    "isomorphic-dompurify": "3.14.0",
    "jose": "^6.2.3",
    "js-yaml": "^4.1.1",
    "lowlight": "^3.3.0",
    "lucide-react": "^1.14.0",
    "mdast-util-from-markdown": "^2.0.3",
    "nitro": "3.0.260429-beta",
    "prismjs": "^1.30.0",
    "react": "^19.2.5",
    "react-dom": "^19.2.5",
    "react-force-graph-2d": "^1.29.1",
    "react-markdown": "^9.0.1",
    "react-simple-code-editor": "^0.14.1",
    "remark-gfm": "^4.0.0",
    "tailwindcss": "^4.2.4",
    "y-indexeddb": "^9.0.12",
    "y-prosemirror": "^1.3.7",
    "y-protocols": "^1.0.7",
    "yjs": "^13.6.30",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@edge-runtime/vm": "^4.0.4",
    "@types/js-yaml": "^4.0.9",
    "@types/jsdom": "28.0.3",
    "@types/node": "^22.13.10",
    "@types/prismjs": "^1.26.6",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^6.0.1",
    "concurrently": "^9.1.0",
    "convex-test": "^0.0.51",
    "typescript": "^5.7.2",
    "vite": "^8.0.10",
    "vitest": "^2.1.9"
  }
}
--- ./package.json
{
  "name": "dohc",
  "private": true,
  "type": "module",
  "engines": {
    "node": "^20.19.0 || ^22.13.0 || >=24.0.0",
    "pnpm": "10.24.0"
  },
  "scripts": {
    "dev": "node scripts/dev-sync.mjs && pnpm --filter @dohc/web --if-present run dev",
    "dev:app": "pnpm --filter @dohc/web --if-present run dev",
    "dev:sync": "node scripts/dev-sync.mjs",
    "dev:hocuspocus": "pnpm --filter @dohc/hocuspocus --if-present run dev",
    "dev:workspace-api": "pnpm --filter @dohc/workspace-api dev",
    "dev:postgres": "docker compose -f docker-compose.dev.yml up -d postgres minio",
    "build": "pnpm -r --if-present build",
    "start": "pnpm --filter @dohc/web --if-present run start",
    "preview": "pnpm --filter @dohc/web --if-present run preview",
    "reset:dev": "node scripts/reset-dev-data.mjs",
    "reset:postgres": "node scripts/reset-postgres-dev-data.mjs",
    "typecheck": "pnpm -r --if-present typecheck",
    "test": "pnpm -r --if-present test",
    "test:e2e": "playwright test",
    "test:hocuspocus:integration": "pnpm --filter @dohc/hocuspocus run test:integration",
    "sync:local": "pnpm --filter @dohc/workspace-fs sync",
    "lint": "pnpm -r --if-present lint",
    "check:dual-backend-baseline": "node scripts/check-dual-backend-baseline.mjs",
    "check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs",
    "check:self-host": "node scripts/check-self-host.mjs",
    "check:debt": "node scripts/check-tech-debt.mjs"
  },
  "packageManager": "pnpm@10.24.0",
  "devDependencies": {
    "@playwright/test": "^1.60.0"
  }
}
--- ./packages/brand/package.json
{
  "name": "@dohc/brand",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./tokens.css": "./src/tokens.css"
  },
  "peerDependencies": {
    "react": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.2.14",
    "react": "^19.2.5"
  }
}
--- ./packages/config/package.json
{
  "name": "@dohc/config",
  "private": true,
  "type": "module"
}
--- ./packages/workspace-contracts/package.json
{
  "name": "@dohc/workspace-contracts",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vitest": "^2.1.9"
  }
}
--- ./packages/workspace-convex-compat/package.json
{
  "name": "@dohc/workspace-convex-compat",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dohc/workspace-contracts": "workspace:*",
    "convex": "^1.37.0",
    "convex-test": "^0.0.51"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vite": "^8.0.10",
    "vitest": "^2.1.9"
  }
}
--- ./packages/workspace-core/package.json
{
  "name": "@dohc/workspace-core",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.19.19",
    "typescript": "^5.9.3",
    "vitest": "^2.1.9"
  }
}
--- ./packages/workspace-fs/package.json
{
  "name": "@dohc/workspace-fs",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "sync": "tsx src/syncClient.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dohc/workspace-contracts": "workspace:*"
  },
  "devDependencies": {
    "@dohc/workspace-api": "workspace:*",
    "@types/node": "^22.19.19",
    "tsx": "^4.22.3",
    "typescript": "^5.9.3",
    "vitest": "^2.1.9"
  }
}
--- ./packages/workspace-postgres/package.json
{
  "name": "@dohc/workspace-postgres",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run --no-file-parallelism",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dohc/workspace-contracts": "workspace:*",
    "drizzle-orm": "^0.45.2",
    "pg": "^8.13.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/pg": "^8.11.11",
    "typescript": "^5.7.2",
    "vitest": "^2.1.9"
  }
}
--- ./services/agent-sandbox/package.json
{
  "name": "@dohc/agent-sandbox",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/server.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dohc/workspace-contracts": "workspace:*",
    "@dohc/workspace-fs": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.19.19",
    "typescript": "^5.9.3",
    "vitest": "^2.1.9"
  }
}
--- ./services/app-tester/package.json
{
  "name": "@dohc/app-tester",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {
    "@playwright/test": "^1.60.0",
    "@types/node": "^22.19.19",
    "tsx": "^4.22.3",
    "typescript": "^5.9.3",
    "vitest": "^2.1.9"
  }
}
--- ./services/hocuspocus/package.json
{
  "name": "@dohc/hocuspocus",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "test:integration": "node scripts/require-integration-env.mjs && vitest run --config vitest.integration.config.ts",
    "lint": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@hocuspocus/provider": "^4.1.0",
    "@hocuspocus/server": "^4.1.0",
    "@tiptap/core": "^3.23.6",
    "@tiptap/extension-table": "^3.23.6",
    "@tiptap/markdown": "^3.23.6",
    "@tiptap/pm": "^3.23.6",
    "@tiptap/starter-kit": "^3.23.6",
    "convex": "^1.39.1",
    "jose": "^6.2.3",
    "js-yaml": "^4.1.1",
    "pg": "^8.21.0",
    "y-prosemirror": "^1.3.7",
    "yjs": "^13.6.30"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.19.19",
    "@types/pg": "^8.20.0",
    "tsx": "^4.22.3",
    "typescript": "^5.9.3",
    "vitest": "^2.1.9"
  }
}
--- ./services/sqlite-worker/package.json
{
  "name": "@dohc/sqlite-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {
    "@types/node": "^22.19.19",
    "tsx": "^4.22.3",
    "typescript": "^5.9.3",
    "vitest": "^2.1.9"
  }
}
--- ./services/workspace-api/package.json
{
  "name": "@dohc/workspace-api",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/server.ts"
  },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@dohc/workspace-contracts": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.19.19",
    "tsx": "^4.22.3",
    "typescript": "^5.9.3",
    "vitest": "^2.1.9"
  }
}

exec
/bin/bash -lc "cat pnpm-workspace.yaml && cat tsconfig.base.json && find packages/workspace-contracts/src -maxdepth 2 -type f -print -exec sed -n '1,200p' {} \\;" in /home/ice/dev/dohc
 succeeded in 126ms:
import { z } from "zod";

export const WorkspaceId = z.string().min(1);
export const UserId = z.string().min(1);
export const AtomId = z.string().min(1);
export const FolderId = z.string().min(1);
export const AssetId = z.string().min(1);
export const DatabaseId = z.string().min(1);

export const WorkspacePath = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/"), "workspace paths are relative")
  .refine(
    (path) => !path.split("/").includes(".."),
    "workspace paths cannot contain ..",
  );

export const AtomKind = z.enum([
  "markdown",
  "text",
  "csv",
  "json",
  "html",
  "app-source",
]);
export type AtomKind = z.infer<typeof AtomKind>;

export const AssetKind = z.enum([
  "image",
  "audio",
  "video",
  "pdf",
  "csv",
  "json",
  "sqlite",
  "file",
]);
export type AssetKind = z.infer<typeof AssetKind>;

export const WorkspaceFile = z.object({
  id: z.string(),
  workspaceId: WorkspaceId,
  path: WorkspacePath,
  kind: z.enum(["atom", "asset", "database"]),
  contentType: z.string(),
  revision: z.string(),
  updatedAt: z.number(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;
packages/workspace-contracts/src/errors.ts
export type WorkspaceErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "locked"
  | "review_required"
  | "invalid_path"
  | "invalid_manifest"
  | "unsupported_media_type";

export class WorkspaceError extends Error {
  constructor(
    public readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}
packages/workspace-contracts/src/conformance.ts
import { describe, expect, it } from "vitest";
import type { WorkspaceBackendTestAdapter } from "./testHarness";

export function runWorkspaceBackendConformance(
  adapter: WorkspaceBackendTestAdapter,
) {
  describe(`${adapter.name} workspace backend conformance`, () => {
    it("creates, reads, and lists a text file", async () => {
      const { backend, actor } = await adapter.setup();
      try {
        await backend.createAtom(actor, {
          path: "finance/transactions.csv",
          kind: "csv",
          body: "date,merchant,amount\n2026-06-01,Atome,26262\n",
        });

        const read = await backend.readText(
          actor,
          "finance/transactions.csv",
        );
        expect(read.body).toContain("Atome");

        const files = await backend.listFiles(actor);
        expect(
          files.some((file) => file.path === "finance/transactions.csv"),
        ).toBe(true);
      } finally {
        await adapter.teardown();
      }
    });

    it("rejects cross-workspace reads", async () => {
      const { backend, actor, otherActor } = await adapter.setup();
      try {
        await backend.createAtom(actor, {
          path: "private/me.md",
          kind: "markdown",
          body: "# Me\n",
        });

        await expect(
          backend.readText(otherActor, "private/me.md"),
        ).rejects.toThrow();
      } finally {
        await adapter.teardown();
      }
    });

    it("rejects stale writes", async () => {
      const { backend, actor } = await adapter.setup();
      try {
        const created = await backend.createAtom(actor, {
          path: "notes/day.md",
          kind: "markdown",
          body: "# Day\n",
        });

        await backend.writeAtom(actor, {
          path: "notes/day.md",
          expectedRevision: created.revision,
          body: "# Day\nUpdated\n",
        });

        await expect(
          backend.writeAtom(actor, {
            path: "notes/day.md",
            expectedRevision: created.revision,
            body: "# Day\nStale\n",
          }),
        ).rejects.toThrow();
      } finally {
        await adapter.teardown();
      }
    });

    it("saves, reads, and lists an uploaded asset", async () => {
      const { backend, actor } = await adapter.setup();
      try {
        const saved = await backend.saveAsset(actor, {
          path: "uploads/receipt.png",
          kind: "image",
          mediaType: "image/png",
          bytes: new Uint8Array([137, 80, 78, 71]),
        });

        expect(saved.kind).toBe("asset");
        expect(saved.contentType).toBe("image/png");

        const read = await backend.readAsset(actor, "uploads/receipt.png");
        expect(read.kind).toBe("image");
        expect(read.mediaType).toBe("image/png");
        expect(Array.from(read.bytes)).toEqual([137, 80, 78, 71]);

        const files = await backend.listFiles(actor);
        expect(files.some((file) => file.path === "uploads/receipt.png")).toBe(
          true,
        );
      } finally {
        await adapter.teardown();
      }
    });

    it("renames a file by leaf name without moving it out of its folder", async () => {
      const { backend, actor } = await adapter.setup();
      try {
        const created = await backend.createAtom(actor, {
          path: "finance/something.md",
          kind: "markdown",
          body: "# Something\n",
        });

        const renamed = await backend.renameFile(actor, {
          fromPath: "finance/something.md",
          toName: "renamed.md",
          expectedRevision: created.revision,
        });

        expect(renamed.path).toBe("finance/renamed.md");
        await expect(
          backend.readText(actor, "finance/something.md"),
        ).rejects.toThrow();
        const read = await backend.readText(actor, "finance/renamed.md");
        expect(read.body).toContain("Something");
      } finally {
        await adapter.teardown();
      }
    });
  });
}
packages/workspace-contracts/src/index.ts
export * from "./backend";
export * from "./domain";
export * from "./errors";
export * from "./events";
export * from "./path";
export * from "./testHarness";
export * from "./conformance";
export * from "./dataImport";
packages/workspace-contracts/src/dataImport.ts
export type ImportSource =
  | { kind: "asset"; path: string }
  | { kind: "atom"; path: string }
  | { kind: "inline"; name: string; mediaType: string; body: string };

export type ImportTarget =
  | { kind: "atom"; path: string; contentType: string }
  | { kind: "sqlite"; path: string; tableName: string }
  | { kind: "collection"; path: string };

export type ImportDataRequest = {
  source: ImportSource;
  target: ImportTarget;
  mode: "infer-schema" | "provided-schema";
  schema?: Record<
    string,
    "text" | "integer" | "real" | "boolean" | "datetime"
  >;
};

exec
/bin/bash -lc "nl -ba packages/workspace-core/src/paths.ts | sed -n '1,120p'" in /home/ice/dev/dohc
 succeeded in 0ms:
     1	export function defaultWorkspaceRoot(homeDir: string): string {
     2	  return `${homeDir.replace(/\/+$/, "")}/dohc`;
     3	}
     4	
     5	export type FolderValidation = { ok: true } | { ok: false; reason: string };
     6	
     7	export function validateAttachedFolder(path: string): FolderValidation {
     8	  if (!path.startsWith("/")) {
     9	    return { ok: false, reason: "attached folders must be absolute paths" };
    10	  }
    11	  return { ok: true };
    12	}
    13	
    14	const RESERVED_PREFIX = ".dohc/";
    15	
    16	export function isReservedPath(relativePath: string): boolean {
    17	  return relativePath === ".dohc" || relativePath.startsWith(RESERVED_PREFIX);
    18	}
    19	
    20	export type WritePathValidation =
    21	  | { ok: true; normalized: string }
    22	  | { ok: false; reason: "traversal" | "absolute" | "reserved" | "invalid" };
    23	
    24	export function validateUserWritePath(relativePath: string): WritePathValidation {
    25	  if (relativePath.includes("\0")) return { ok: false, reason: "invalid" };
    26	  if (relativePath.startsWith("/")) return { ok: false, reason: "absolute" };
    27	  // Percent-encoded dots/separators are traversal in disguise; decode until
    28	  // stable so double-encoding (%252e -> %2e -> .) cannot slip through.
    29	  let decoded = relativePath;
    30	  for (;;) {
    31	    const next = decoded
    32	      .replace(/%25/gi, "%")
    33	      .replace(/%2e/gi, ".")
    34	      .replace(/%2f/gi, "/")
    35	      .replace(/%5c/gi, "\\");
    36	    if (next === decoded) break;
    37	    decoded = next;
    38	  }
    39	  const segments = decoded.replaceAll("\\", "/").split("/");
    40	  if (segments.includes("..")) return { ok: false, reason: "traversal" };
    41	  const normalized = segments
    42	    .filter((segment) => segment !== "" && segment !== ".")
    43	    .join("/");
    44	  if (normalized.length === 0) return { ok: false, reason: "invalid" };
    45	  if (isReservedPath(normalized)) return { ok: false, reason: "reserved" };
    46	  return { ok: true, normalized };
    47	}
    48	
    49	export type PathClassification =
    50	  | { kind: "app-source"; appName: string }
    51	  | { kind: "database" }
    52	  | { kind: "file" };
    53	
    54	const DATABASE_EXTENSIONS = [".sqlite", ".sqlite3", ".db"];
    55	
    56	export function classifyPath(relativePath: string): PathClassification {
    57	  const segments = relativePath.split("/");
    58	  const appsIndex = segments.indexOf(".apps");
    59	  const appName = appsIndex === -1 ? undefined : segments[appsIndex + 1];
    60	  if (appName) return { kind: "app-source", appName };
    61	  const lower = relativePath.toLowerCase();
    62	  if (DATABASE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    63	    return { kind: "database" };
    64	  }
    65	  return { kind: "file" };
    66	}

exec
/bin/bash -lc "sed -n '1,260p' docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md 2>/dev/null || true && sed -n '1,220p' docs/superpowers/*desktop* 2>/dev/null | head -200" in /home/ice/dev/dohc
 succeeded in 0ms:
# dohc Desktop Local-First Cloud Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. If those skills are unavailable, use native orchestration instead: a lead agent implements phases sequentially, fans out parallel subagent review workflows at every major checkpoint (security, UX/screenshot, performance, deletion-safety), runs long test suites in the background, and self-paces with scheduled wakeups so execution continues unattended. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pivot dohc from a web-first Convex workspace into an Electron-first, local-file-first workspace that syncs to dohc Cloud or self-hosted Postgres, lets local Codex/Claude Code work directly on files, and preserves dohc's collaboration, apps, SQLite, provenance, and agent-testing strengths.

**Product thesis:** Files are local and owned, but they are not *just* local files — they are building blocks people share and build on together. dohc brings git-grade building-collaboration (change sets, history, attribution, review at real boundaries, AI-assisted merge) to everyday people, the way git brought it to engineers. Local-first accountless use is the free trust wedge; dohc Cloud is the paid collaboration engine. Without the collaboration layer, dohc is arguably an Obsidian clone — with it, it is a new category. Collaboration surfaces are first-class product, never sync plumbing.

What separates dohc from Obsidian-class tools is three legs, and the combination is the moat: (1) agents are first-class workers with infrastructure — change sets, provenance, attribution, review gates, MCP tools, tested apps — not bolted-on plugins with folder access; (2) work primitives beyond notes — real SQLite databases, data imports, and source-backed apps a user's agent can build and dohc can test; (3) git-grade collaboration. Local files, markdown, speed, and a command palette are table stakes adopted from Obsidian, not differentiation — every phase should protect all three legs, and users' agents (not a plugin marketplace) are dohc's ecosystem.

**Architecture:** Workspaces are real folders on disk. The desktop app is the primary product surface and runs a local dohc core that watches folders, batches changes, maintains `.dohc/` metadata, serves the React renderer, exposes MCP/tools to local agents, and syncs with dohc Cloud/self-hosted Postgres when enabled. The existing dual-backend branch is treated as a completed prototype: keep/port the useful Postgres, filesystem, app, SQLite, sandbox, upload, and AppTester pieces; delete Convex and web-first compatibility paths once equivalent local-first tests prove the replacement.

**Tech Stack:** Electron, React/TanStack Start renderer, TypeScript, Vite/electron-vite or equivalent Electron Vite build tooling, Playwright Electron automation, Vitest, Postgres, Drizzle ORM, Better Auth (inside workspace-api, Drizzle adapter on the same Postgres) for cloud/self-host authentication, Hocuspocus/Yjs for live collaborative text in shared workspaces, local filesystem storage, S3-compatible object storage for cloud/self-host, SQLite worker/AppTester services, MCP server for Codex/Claude integration, Docker Compose for self-host/dev.

---

## Research Basis

Use these references while implementing:

- Electron security checklist and context isolation: `https://www.electronjs.org/docs/latest/tutorial/security`
- Electron context isolation: `https://www.electronjs.org/docs/latest/tutorial/context-isolation`
- Electron sandboxing: `https://www.electronjs.org/docs/latest/tutorial/sandbox`
- Electron fuses: `https://www.electronjs.org/docs/tutorial/fuses`
- Electron IPC: `https://www.electronjs.org/docs/latest/tutorial/ipc`
- Playwright Electron automation: `https://playwright.dev/docs/api/class-electron`
- electron-vite guide and CLI: `https://electron-vite.org/guide/`, `https://electron-vite.org/guide/cli`
- Electron Forge Vite plugin if the implementer chooses Forge instead of electron-vite: `https://www.electronforge.io/config/plugins/vite`
- electron-builder signing and updates: `https://www.electron.build/docs/features/code-signing/`, `https://www.electron.build/docs/features/auto-update/`
- Chromium performance APIs for renderer marks/measures: `https://developer.mozilla.org/docs/Web/API/Performance`
- React profiler for targeted render-cost investigation: `https://react.dev/reference/react/Profiler`
- Local reference implementation: `/home/ice/dev/oss-repos/t3code/apps/desktop`
- Better Auth docs (Drizzle adapter, organization plugin, device authorization, SSO): `https://www.better-auth.com/docs`
- Hocuspocus server/provider docs: `https://tiptap.dev/docs/hocuspocus`
- Yjs docs: `https://docs.yjs.dev`

Important lessons from the references:

- Keep `contextIsolation: true`, `nodeIntegration: false`, and renderer sandboxing enabled.
- Expose only narrow, validated preload APIs through `contextBridge`.
- Treat IPC as an untrusted boundary; validate every payload and sender.
- Use Playwright's Electron launcher to drive real desktop E2E tests.
- For packaging, signed/notarized builds and update metadata matter; unsigned dev builds are fine, unsigned release builds are not.
- `electron-vite` is a good fit for a Vite/React codebase, but Electron Forge + Vite is acceptable if it better fits repo conventions.
- t3code's desktop package is a useful pattern: explicit desktop package, main/preload separation, desktop bridge contract, desktop auth/bootstrap, update tests, smoke tests, and release artifact scripts.
- Desktop performance must be measured inside the real Electron app, not inferred from unit tests.
- Native-feeling performance requires startup, first paint, file-tree rendering, search, sync, app open, and database operations to have explicit budgets.

## Strategic Decisions Already Made

- Cut Convex in the new architecture.
- Use Postgres for dohc Cloud and self-hosted sync/collaboration.
- Use Better Auth (running inside workspace-api on the Drizzle/Postgres stack) for dohc Cloud and self-host authentication: email/password plus the device authorization flow for desktop login and the organization plugin for teams. Self-hosters get working auth with no external vendor account. WorkOS is deferred as an optional enterprise SSO/SCIM provider plugged in behind Better Auth when a business customer requires it.
- Live real-time co-editing (Yjs/Hocuspocus) for markdown/text in shared workspaces is in scope for this plan. Raw SQLite bytes and binary assets are still never CRDT-synced. Hocuspocus ACL must be ported off Convex to Postgres.
- Collaboration is the business model: local-first accountless use is the free wedge; dohc Cloud monetizes shared building — team workspaces, sync, live co-editing, change-set history, attribution, and AI-assisted merge. The history/attribution/catch-up surfaces are user-facing product, required even in local-only mode so sharing adds zero new concepts.
- Build Electron desktop first.
- Keep web, but make it secondary: cloud access, shared links, mobile-friendly access, and users without desktop.
- Local-only use works with no account.
- dohc Cloud login is required only for cloud sync, hosted agents, sharing, backups, teams, and multi-device cloud features.
- Personal workspaces default to local-first.
- Shared/team workspaces default to cloud-first with an always-available local working copy.
- Cloud-only workspaces remain optional for web/mobile/shared-link use.
- Sync is automatic but settled/batched, not immediate per filesystem event.
- dohc builds its own AI-native sync/history/change-set model instead of using Git as the default.
- Git integration may be added later as optional export/mirror/integration.
- Apps are visible source folders under `.apps/<name>/`, with internal build/cache.
- User-meaningful SQLite databases can be visible `.sqlite` files; hidden managed databases are allowed only for internal cache/app internals.
- Collaboration is liberal by default: if the user has edit access, they and their agent can edit. Interrupt only on real boundary crossings.
- Federation between dohc Cloud and separate self-hosted instances is deferred.
- License choice is deferred, but the architecture must be open-source/self-host ready.

## What The Completed Old Plan Gives Us

The completed `2026-06-09-dohc-dual-backend-filesystem-agent-runtime.md` branch provides useful substrate:

- `packages/workspace-contracts`
- `packages/workspace-postgres`
- `packages/workspace-fs`
- `services/workspace-api`
- `services/agent-sandbox`
- uploads and file-type views
- AppTester and app quality gates
- app/SQLite runtime and operation-log ideas
- agent output/activity separation
- backend matrix patterns
- tech debt/deletion audit patterns

This plan should port, promote, or reuse those pieces where they fit.

This plan should delete:

- Convex backend support.
- `packages/workspace-convex-compat`.
- dual-backend switching that exists only to compare Convex and Postgres.
- web-first atom/tool paths that duplicate local-file-first behavior.
- `.views` product-language paths once `.apps` compatibility/migration tests prove safe deletion.
- stale onboarding and agent prompt fragments that assume dohc is a cloud notes app.

## Non-Negotiables

- Do not weaken authorization, ownership, sharing boundaries, locks, review gates, app trust, provenance, or workspace scoping.
- Do not make local sync an unmanaged overwrite path.
- Do not turn shared/team collaboration into a restrictive permission maze. If a user has edit access, normal edits sync automatically.
- Boundary crossings still need guardrails: public publishing, external sharing, permission changes, bulk deletes, app trust/install, private-to-shared moves, and unmergeable overwrites.
- Renderer code must never get raw Node/Electron access.
- Preload APIs must be narrow and validated.
- Desktop shell/MCP capabilities must be powerful but workspace-scoped by default.
- Local-only personal workspace edits should not require approval.
- Shared/team normal edits should not require approval if the user has edit access.
- Do not CRDT-sync raw SQLite bytes.
- Do not store generated binary assets as markdown text.
- User-meaningful work must remain inspectable as files, assets, apps, or databases.
- Reduce tech debt while implementing. Delete obsolete code when tests prove it is safe.
- Performance is a product invariant. The desktop app must feel native and fast; do not accept slow startup, janky typing, sluggish file trees, expensive sync loops, or slow agent/app/database flows as "good enough."

## UI/UX Direction

dohc Desktop should preserve the current dohc feel: simple, clean, muted, warm, and work-focused. The evolution should make it feel more native and capable, not louder.

Take inspiration from:

- Obsidian: local files, calm sidebar, fast command palette, keyboard-first navigation, no heavy chrome.
- Codex/Claude Code: agent work feels active, inspectable, and powerful without decorative UI.
- t3code: desktop-first shell, local agent/runtime affordances, useful status surfaces, app-like polish.
- Linear/Raycast-level restraint: dense but readable controls, crisp typography, responsive interactions.

Do:

- keep warm paper + graphite as the product base.
- keep spacing compact and calm.
- make the file tree, command palette, editor, app runtime, sync status, and agent activity feel like native desktop surfaces.
- use subtle dividers, hover states, and active states.
- prefer icons plus short labels for commands.
- preserve keyboard shortcuts and quick switching.
- make local/cloud/sync state obvious without banners everywhere.
- make first launch immediately usable: create/open a workspace, not a marketing page.
- use screenshots and E2E checks to verify layout, text fit, and nonblank rendering.

Do not:

- add marketing-style hero sections to the desktop app.
- add gradient/orb decoration.
- make card-heavy dashboards for core workspace UI.
- make one-note purple/blue/dark-slate palettes.
- hide real files behind abstract product terms.
- ship a web page inside Electron without desktop affordances.
- make agent progress one giant paragraph.
- let text overflow, wrap badly, or occlude controls.

UI quality bar:

- default desktop shell should feel boring in the best way: obvious, fast, and trustworthy.
- every primary screen should be usable at 1280x800 and 1536x960.
- empty states should offer the next real action, not explain the product.
- file/app/database/media views should feel like different file types, not markdown with costumes.
- sync/conflict/agent activity should be inspectable but not noisy.

Native app feel requirements (what separates a legit desktop app from a website in a frame):

- custom titlebar integrated with the shell: draggable regions, platform-correct window controls, no default browser chrome.
- window state persists across launches: size, position, maximized state, last workspace.
- real menus: application menu and right-click context menus on files, folders, tabs, and editor selections — not web dropdowns pretending.
- keyboard-first everywhere: every primary action reachable without the mouse; platform-correct modifiers; visible focus states for keyboard users only.
- no web artifacts: no text-selection cursor on chrome, no image/link dragging, no pull-to-refresh or rubber-band on static surfaces, no FOUC or white flash on launch (background color set before first paint), no browser zoom on ctrl+scroll unless intentional.
- typography tuned for UI density: UI font stack for chrome, content font for documents; crisp rendering; no document-scale headings inside tool surfaces.
- one spacing grid (4px base) and one restrained token set: current dohc warm paper + graphite, one accent, subtle radii, shadows only for true elevation (menus, palette, dialogs).
- system theme (light/dark) followed without flashing or interrupting running work.
- resize behaves natively: panels reflow without jank, sidebar widths persist, no layout shift on font load.
- interactions acknowledge instantly: hover/active states under 50ms, skeletons only where real latency exists.

### Design Review Loop (required for every UI phase)

Phases 3, 6, 7 (app runtime UI), 9 (login UI), 10 (collab/conflict UI), 11 (settings/agent UI), and 18 must run this loop before their phase commit:

1. Before first implementation in Phase 3: recon the t3code renderer (`/home/ice/dev/oss-repos/t3code/apps/desktop`) and record which layout, titlebar, panel, and status-surface patterns to adopt or reject.
2. Capture screenshots of every new/changed surface at 1280x800 and 1536x960, light and dark, via the Playwright Electron tests.
3. Run a dedicated design-review subagent over the screenshots with this rubric, each item scored pass/fail:
   - looks like a native desktop app, not a web page in Electron.
   - clean, professional, calm: would not look out of place next to Obsidian, Linear, or Raycast.
   - consistent with dohc's warm paper + graphite identity; no palette drift.
   - spacing, alignment, and type hierarchy are deliberate; nothing cramped, floating, or misaligned.
   - no text overflow, truncation surprises, or occluded controls.
   - empty/loading/error states designed, not defaulted.
   - no marketing chrome, gradients/orbs, or card-heavy dashboard syndrome.
4. Fix every fail and re-run the loop. Maximum 3 iterations per UI phase. Hard items (text overflow, occluded controls, blank render, marketing chrome, palette drift from tokens) block the phase unconditionally. Soft aesthetic items still failing after 3 iterations become explicit deferred findings with screenshots in the execution log, re-judged at the Phase 18 readiness review.
5. A UI phase is not complete while any hard rubric item fails.
6. Screenshot convention (established by the Phase 2 launch E2E): tests write to `test-results/screenshots/phase-<NN>/<surface>--<width>x<height>--<light|dark>.png`. The design-review brief is fixed: "Review every PNG under `test-results/screenshots/phase-<NN>/` against the rubric; output per-file, per-item pass/fail with the failing region described." Include 2-3 reference screenshots from earlier passing phases to anchor consistency across fresh-context judges.

## Performance Budgets

These budgets are initial targets for the implementation. If a target is impossible in CI due to hardware/display limitations, the agent must record the local measured number, explain the environment, and keep a tighter relative regression budget.

Desktop UX budgets:

- cold desktop launch to first visible shell: under 2.0s on the local dev machine.
- warm launch to first visible shell: under 1.0s.
- first local workspace creation: under 1.0s for an empty workspace.
- open existing workspace with 1,000 files: under 1.5s to interactive file tree.
- file tree filter/search over 10,000 paths: under 100ms for the query operation and under 200ms to visible result.
- open markdown file under 250KB: under 150ms after click.
- typing latency in markdown editor: no sustained frame over 16ms during normal typing; no long task over 50ms.
- file watcher settle and detect single markdown save: under 2.0s.
- batch 100 changed files into one change set: under 3.0s without blocking the renderer.
- open `.apps/<name>` runtime after build cache warm: under 1.0s.
- run AppTester static+browser smoke for a small app: under 15s in CI/dev.
- open SQLite table with 10,000 rows: under 1.0s to first page.
- import 10,000-row CSV to SQLite: under 5.0s in local dev.

Resource budgets:

- renderer idle CPU should return near idle (~0%) after sync/app/test operations finish.
- no unbounded polling loops.
- large file indexing must be incremental or worker-backed.
- sync, import, AppTester, and SQLite work must not block the Electron renderer.
- desktop memory after opening a 1,000-file workspace: initial target under 400MB working set, measured and recorded; regressions over 20% require investigation.
- initial renderer JS loaded before first shell paint: initial target under 3MB; the build must print bundle size, and unexplained growth over 10% between phases fails the performance check.
- no memory growth across repeated workspace open/close cycles (leak check).

Performance engineering rules (anti-bloat):

dohc Desktop is the antithesis of Notion-class bloated Electron apps. Slowness is a bug, not polish debt. These rules apply to every phase, not just Phase 16:

- dependency discipline: every new dependency is justified in the execution log — what it does, its size and transitive cost, and the alternative considered. Prefer the platform/stdlib. No kitchen-sink UI kits.
- first-paint discipline: only code needed to paint the shell loads at startup. Everything else is lazy-loaded or deferred to idle. No blocking IPC round trips before first paint. Window background color is set before first paint (no white flash).
- the renderer renders; it does not compute: parsing, scanning, hashing, indexing, imports, SQLite, and app builds run in main-process services or workers. A renderer long task over 50ms on a hot path is a bug.
- virtualize every unbounded surface: file tree, tables, search results, history, agent activity.
- IPC is batched and coalesced: no per-keystroke or per-file-event round trips.
- animations use transform/opacity only; nothing that forces layout on a hot path.
- React hot paths are profiled: no full-tree re-renders on keystroke, file event, or sync tick.
- measure first, optimize second: every optimization records before/after numbers in the execution log.

Continuous enforcement (do not defer performance to Phase 16):

- Phase 2 ships the minimal measurement harness with the scaffold: launch/first-paint marks and a measurements JSON written by the Playwright Electron tests.
- Every subsequent phase that adds a measurable surface (file tree, editor, sync, apps, SQLite, imports, agents) adds its marks and measurements in that phase and records the numbers in the execution log.
- Phase 16 formalizes budgets into the hard `check:performance` gate and ratchets existing measurements — it must not be the first time a number is seen.
- A phase that makes a previously recorded measurement materially worse must fix it in that phase, not defer it.

Every phase touching UI, filesystem watching, sync, database import, app runtime, or agent tooling must add or update a performance check.

## Code Size And Deletion Rules

The fewer lines delivered, the better. This pivot must shrink the codebase, not grow a second product beside the old one. Code deletion is highly valued work.

- Deletion is part of every phase's definition of done, not a Phase 17 sweep. When a replacement lands with passing tests, the replaced path dies in the same phase. Phase 17 is the final audit, not where deletion starts.
- Reuse before write: before creating any new helper, module, or component, search for an existing one to promote or extend — the dual-backend substrate and current app are large. Duplication discovered later is a phase bug, not acceptable drift.
- Smallest implementation that passes the tests: no speculative abstraction, no config options nobody asked for, no wrapper layers around single call sites, no manager/factory/registry indirection without at least two real consumers today.
- Track net LOC per phase: record `git diff --shortstat` for every phase commit in the execution log. Product-surface phases may be net-positive; integration, repositioning, and deletion phases (12, 13, 17) must be strongly net-negative. Unexplained growth is a review finding to fix.
- Track branch-total LOC versus main at every major checkpoint. Deleting Convex, the compat package, dual-backend switching, and web-first duplicates should offset much of the new desktop/sync/auth code; record the honest number and justify the trend.
- Codex per-phase reviews must be prompted to flag over-engineering, orphaned/unreachable code, and simplification opportunities — not just bugs.
- Never record deferred work as code comments — the debt gate (`check:debt`) fails on the literal deferred-work marker tokens it scans for, and the failure surfaces phases later, far from its cause. Deferred work goes in the execution log's deferred-findings list with a completion condition. Adding entries to the check-tech-debt or knip allowlists for code this branch authored is forbidden; allowlists are for pre-existing/historical paths only, and every addition must be named in that phase's Codex review prompt.

## AI Agent Execution Contract

The implementing agent should assume the user is AFK and keep going until completion or a real blocker.

### Required Read Order (Tiered For Finite Context)

The lead reads inline, once per fresh context:


exec
/bin/bash -lc "grep -n \"Phase 1\\|Phase 01\\|local-first workspace core\" -n docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md | head -30 && sed -n '260,430p' docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md" in /home/ice/dev/dohc
 succeeded in 0ms:
185:4. Fix every fail and re-run the loop. Maximum 3 iterations per UI phase. Hard items (text overflow, occluded controls, blank render, marketing chrome, palette drift from tokens) block the phase unconditionally. Soft aesthetic items still failing after 3 iterations become explicit deferred findings with screenshots in the execution log, re-judged at the Phase 18 readiness review.
221:dohc Desktop is the antithesis of Notion-class bloated Electron apps. Slowness is a bug, not polish debt. These rules apply to every phase, not just Phase 16:
232:Continuous enforcement (do not defer performance to Phase 16):
236:- Phase 16 formalizes budgets into the hard `check:performance` gate and ratchets existing measurements — it must not be the first time a number is seen.
245:- Deletion is part of every phase's definition of done, not a Phase 17 sweep. When a replacement lands with passing tests, the replaced path dies in the same phase. Phase 17 is the final audit, not where deletion starts.
325:- Design judge panels: before implementing the sync protocol (Phase 9) and the conflict/co-editing model (Phase 10), generate at least 3 independent designs and score them with parallel judges against concrete failure scenarios: concurrent edit, offline rename, half-written file, watcher storm, clock skew, partial upload, reconnect-after-divergence. Each candidate is a doc with fixed sections: data model, message/protocol flow, behavior under each named failure scenario, estimated LOC and new dependencies, what it deletes. Judges receive identical briefs (candidate docs + Non-Negotiables + sync payload list + settle windows + perf budgets) and output a scored matrix (scenario × design, 0-2) plus a one-paragraph verdict. The winning design goes to `docs/architecture/` (losing designs and fatal flaws included); the Decision Ledger gets a one-line entry.
334:- Effort tiering: checkpoint `--base main` reviews, per-phase reviews for security/sync/data-loss/deletion phases (2, 4, 5, 9, 10, 11, 13), design red-teams, the Phase 13 pre-deletion audit, and recovery consults run at `model_reasoning_effort="xhigh"`. Per-phase reviews for low-risk phases (0, 1, 12, 14, 15), adversarial scenario consults, and screenshot judging run at `"high"`. Remaining phases default to xhigh.
337:- At every major checkpoint: run `codex exec review -m gpt-5.5 -c model_reasoning_effort="xhigh" --base main` (checkpoints are always xhigh) over the cumulative branch diff with targeted questions for that checkpoint's risk area (e.g., IPC validation at Phase 4, merge/data-loss at Phase 10, deletion completeness at Phase 13).
347:- Independence rule: Codex never reviews an artifact Codex authored or materially shaped. Codex authors no code, no tests, and no candidate designs in this repo — its only write target is its own transcript under `docs/superpowers/reviews/codex/`. Codex is never assigned an implementation lane, utility module, script, or migration, in any worktree or phase: commit-scoped reviews must never audit their own author, and ChatGPT usage limits are reserved for judgment, not keystrokes. Where Codex consults influence landed work (adversarial scenarios, recovery diagnoses, design-review findings), the phase log records provenance in one line each; the Phase 18 readiness review audits that no phase-commit review covered Codex-originated artifacts beyond triaged review findings.
355:2. Adversarial scenario consult (post-Phase-4 checkpoint: IPC validation; Phase 10: the six data-loss cases; post-Phase-11 checkpoint: MCP path scoping; 3 calls, high effort): `codex exec` read-only, prompted to ENUMERATE concrete attack/loss scenarios (inputs, sequence, expected invariant violation) — output is scenario descriptions, never test files or repo writes. The lead transcribes chosen scenarios into owned tests under normal TDD (recorded RED required), discards duplicates per the code-size rules, and logs which landed scenarios were Codex-origin. A scenario asserting behavior that contradicts the plan's contracts is rejected with reasoning, never satisfied by weakening the implementation.
356:3. Recovery consult (rare; see Recovery Protocol): one bounded fresh-model diagnosis before any blocked declaration or Phase 16 deferral.
357:4. Pre-deletion audit (Phase 13, 1 call, xhigh): see Phase 13 Step 2.5.
358:5. Advisory screenshot pass (Phases 3 and 18 only; 2 calls, high effort, via `-i` attachments; conditional on the Phase 0 `-i` preflight): score ≤8 representative PNGs against the Design Review Loop rubric verbatim. Strictly advisory — the Claude design-review subagent remains the sole gating judge. Hard-item disagreements are re-examined once by the lead against the actual pixels before the phase commit; soft-item disagreements become deferred findings for the Phase 18 re-judge. On `-i` error or timeout, skip silently.
373:Phase 1:  none — single lead lane (tiny phase, shared scaffolding).
379:Phase 10: after judge panel: Lane A=collaborationPolicy (workspace-sync), Lane B=conflictResolution (workspace-history), Lane C=postgres-acl (hocuspocus). Lead-owned tail: useCollabDoc, sync UI, both E2E specs (two-client E2E in background).
380:Phase 12: none — global rename is single-agent by nature.
381:Phase 13: Step 1 fans out one read-only verifier per ported-test-map row (locate test, run it, confirm it fails when implementation is stubbed). Steps 3-5 deletion is explicitly single-agent (global lockfile/import surgery). Post-deletion battery in background.
382:Phase 14: optional 2 lanes: A=update state machine, B=builder config+smoke+docs. Packaging build in background.
383:Phase 15: fan out one doc-writer per document (5 lanes, self-contained briefs incl. product-shape bullets + thesis + phase outcomes). Lead writes the check script; smokes in background.
384:Phase 16: measurement runs require quiescence (below). Optimization fixes MAY lane per disjoint target; authoritative re-measure on merged tree, quiesced.
385:Phase 17: discovery findings partitioned across read-only classifiers; consolidation rows lane per owner package when duplicate sites are disjoint. Verification battery sequential-in-background.
386:Phase 18: none — the readiness E2E is one intentionally sequential flow.
391:ALWAYS background (registered in Resume Snapshot, with completion notification): docker compose stacks; workspace-api/hocuspocus/web dev servers (never foreground — WSL safety); the baseline script; full `pnpm -r` test/typecheck; full `pnpm test:desktop:e2e`; electron-builder packaging; `pnpm check:self-host`; Phase 17/18 verification batteries; all `codex exec review` runs; the two-client liveCoEditing E2E.
420:- Fresh-model consult (required before declaring blocked): when the same blocker survives three concrete attempts, or a Phase 16 metric is still over budget after its 3 optimization attempts, the lead writes a self-contained brief to `docs/superpowers/reviews/codex/blocker-<phase>-<slug>.md` (symptom, exact failing command, path to full output, files inspected, the three attempts and why each failed) and makes ONE `codex exec` consult — read-only sandbox, xhigh, 20-minute timebox, backgrounded — asking for the most likely root cause and the smallest concrete fix or next experiment. Rules: this is attempt 4-of-4, never a counter reset; any proposed diagnosis must be independently confirmed by the lead via repro or exact code citation before any code change; if Codex is unavailable or the timebox expires, proceed directly to the blocked report (zero retries). The diagnosis file is attached to any blocked report. This consult is exempt from the per-phase review budget but logged in the call ledger.
429:- after Phase 10: merge/data-loss and live co-editing review.
430:- after Phase 11: MCP/agent-power review.
431:- after Phase 13: Convex deletion review.
432:- after Phase 16: performance review.
433:- after Phase 17: codebase excellence/deletion review.
434:- after Phase 18: full product readiness review.
grep: write error: Broken pipe

1. `AGENTS.md` (auto-injected) and `apps/app/AGENTS.md` (short)
2. `docs/superpowers/reviews/2026-06-09-dual-backend-readiness-review.md` and `...-tech-debt-audit.md` (short)
3. This plan's front matter (top through "Planned Repository Shape") and ONLY the current phase's section

The lead delegates to read-only digest subagents (Phase 0, digests stored in the execution log's Reference Digests section, ≤25 lines each):

- `docs/superpowers/plans/2026-06-09-dohc-dual-backend-filesystem-agent-runtime.execution-log.md` (95KB)
- `apps/app/convex/_generated/ai/guidelines.md` (20KB) — required before deleting or porting Convex code
- the t3code renderer (`/home/ice/dev/oss-repos/t3code/apps/desktop`)
- external reference URLs (Electron security/fuses, Better Auth, Hocuspocus, Yjs)

Resumed contexts read digests, never sources; go to a source only when the digest is demonstrably insufficient for the immediate task, and update the digest afterward. The lead never WebFetches or bulk-reads reference material inline.

Governance exception (hard rule): digests may summarize historical plans, reviews, and reference repos. They may NOT replace direct reading of active governance files before editing code under those rules — `AGENTS.md`, `apps/app/AGENTS.md`, and `apps/app/convex/_generated/ai/guidelines.md` (before any Convex edit/port/deletion) are read directly by whoever edits the governed code, lead or lane.

### Continuous TDD Loop

For every phase:

1. inspect existing implementation.
2. write the smallest execution map into this plan's execution log.
3. write or update failing tests first.
4. run the tests and record the failure.
5. implement the smallest production change.
6. run targeted tests and record the pass.
7. run relevant regression/security/collaboration/Electron E2E tests.
8. perform a delete-or-justify pass.
9. inspect `git diff --stat` and security-sensitive diffs.
10. run a user-level smoke for the phase where applicable.
11. update the execution log.
12. commit the phase.
13. run independent third-party review of the phase commit (`codex exec review -m gpt-5.5 --commit <phase-sha>` at the effort tier specified in the Codex third-party review section: xhigh for high-risk phases 2, 4, 5, 9, 10, 11, 13, 16, 17, 18; high for low-risk phases 0, 1, 12, 14, 15); record findings in the execution log; fix or explicitly reject every finding; land fixes as follow-up commits.

If a named test/helper does not exist, create it.

Do not stop because:

- the work is long.
- the context is large.
- tests are slow.
- implementation is hard.
- code deletion is uncomfortable.
- the current slice is "mostly working."

### Per-Phase Self-Review Loop

After every phase, the agent must answer in the execution log:

- What user-visible flow works now?
- What did I test at unit/integration/E2E level?
- What did I delete or consolidate?
- What old code did I keep and why?
- Could this phase have shipped with less code? What did I deliberately not build?
- What could still regress?
- Which command proves this phase is safe?

If any answer is weak, fix before moving on.

### Orchestration, Loops, And Third-Party Review

Execution uses native multi-agent orchestration. This is required, not optional:

- A lead agent implements phases sequentially (phases are dependency-ordered) and owns the execution log and all commits.
- Recon fan-out: before heavy phases (0, 5, 9, 10, 16), the lead fans out parallel read-only subagents to digest prior art, reference repos, and current docs instead of reading everything inline.
- Design judge panels: before implementing the sync protocol (Phase 9) and the conflict/co-editing model (Phase 10), generate at least 3 independent designs and score them with parallel judges against concrete failure scenarios: concurrent edit, offline rename, half-written file, watcher storm, clock skew, partial upload, reconnect-after-divergence. Each candidate is a doc with fixed sections: data model, message/protocol flow, behavior under each named failure scenario, estimated LOC and new dependencies, what it deletes. Judges receive identical briefs (candidate docs + Non-Negotiables + sync payload list + settle windows + perf budgets) and output a scored matrix (scenario × design, 0-2) plus a one-paragraph verdict. The winning design goes to `docs/architecture/` (losing designs and fatal flaws included); the Decision Ledger gets a one-line entry.
- Per-phase verification workflow: after the lead believes a phase is complete, fan out parallel verifier subagents before the phase commit: claimed-vs-actual completion check, test-quality check (do the tests actually fail without the implementation?), and UI screenshot review for UI phases.
- Checkpoint review workflows: at each major checkpoint below, run a multi-agent adversarial review with distinct lenses (security, collaboration/authz, performance, deletion-safety, data-loss) where each finding is independently verified before being accepted as real.
- Loops: the lead self-paces with scheduled wakeups and keeps executing while the user is AFK. Long test suites, builds, and dev servers run in the background; the lead never blocks the session foreground on a slow suite.

Codex third-party review (required):

- Tool: `codex exec review` (Codex CLI, verified installed and authenticated in this environment).
- Model: always pass `-m gpt-5.5` (verified working on this account; `gpt-5.5-fast` is not available under ChatGPT-account auth and adds output speed, not review depth). Do not modify the user's global `~/.codex/config.toml`.
- Effort tiering: checkpoint `--base main` reviews, per-phase reviews for security/sync/data-loss/deletion phases (2, 4, 5, 9, 10, 11, 13), design red-teams, the Phase 13 pre-deletion audit, and recovery consults run at `model_reasoning_effort="xhigh"`. Per-phase reviews for low-risk phases (0, 1, 12, 14, 15), adversarial scenario consults, and screenshot judging run at `"high"`. Remaining phases default to xhigh.
- For Phases 5, 8, and 10, the review prompt must additionally ask: "name any silent-data-loss scenario the tests do not cover" — scenario-completeness is a different question than code correctness.
- After every phase commit: run `codex exec review -m gpt-5.5 --commit <phase-sha>` at the phase's effort tier (see Effort tiering below). VERIFIED CONSTRAINT (0.130.0 and 0.137.0-alpha both): `--commit` cannot be combined with a custom prompt — commit-scoped reviews run with Codex's default review instructions, which is acceptable. For high-risk phases (2, 4, 5, 9, 10, 11, 13), follow with a targeted plain `codex exec` read-only call prompting the phase's specific risk areas plus over-engineering/orphaned-code/simplification findings against `git show <phase-sha>`. Record findings in the execution log.
- At every major checkpoint: run `codex exec review -m gpt-5.5 -c model_reasoning_effort="xhigh" --base main` (checkpoints are always xhigh) over the cumulative branch diff with targeted questions for that checkpoint's risk area (e.g., IPC validation at Phase 4, merge/data-loss at Phase 10, deletion completeness at Phase 13).
- Accountability: every Codex finding is either fixed (with a test where applicable) or explicitly rejected with reasoning in the execution log. Fixes land as follow-up commits in the same phase; do not amend or squash.
- Codex runs read-only as a reviewer; it must not edit the repo. The lead implements fixes.
- Pipelining: Codex reviews ALWAYS run as background tasks with stdout redirected to `docs/superpowers/reviews/codex/phase-NN.md`, launched immediately after the phase commit. While a review runs, the lead performs only read-only next-phase work (recon fan-outs, execution-map drafting, failing-test design — no commits, no shared-file mutation). A triage subagent reads the output file, dedupes, verifies each finding against actual code, and returns ≤15 numbered one-line actionable findings; the lead reads the raw transcript only when a triaged finding is ambiguous. Findings are triaged before the next phase's first commit.
- Re-review cap: follow-up fix commits get at most ONE targeted re-review per phase; residue rolls into the next checkpoint's cumulative `--base main` review.
- Invoke codex by the absolute path recorded in the execution log Environment section (PATH drift in fresh shells must not break the gate). If codex is temporarily unavailable, mark the phase "codex review pending," continue, and retry via self-paced wakeups (~10/30/60 min, max 3); a pending review is never silently dropped — the acceptance criteria remain the backstop.
- The gate is "independent third-party review," not one vendor binary. Phase 0 preflight verifies `codex` + `gpt-5.5` availability and records the result. If the exact tool/model is unavailable to the runner (different machine, CI, auth limits), the gate is satisfied by the first available fallback, recorded per phase in the execution log: (1) another available Codex model at the highest reasoning effort, (2) CodeRabbit review, (3) an independent adversarial verifier-subagent panel using the Checkpoint Review Recipe plus manual reviewer signoff. A runner without the preferred tool can therefore still complete every phase and the acceptance criteria.

Codex hard rules (independence and budget):

- Independence rule: Codex never reviews an artifact Codex authored or materially shaped. Codex authors no code, no tests, and no candidate designs in this repo — its only write target is its own transcript under `docs/superpowers/reviews/codex/`. Codex is never assigned an implementation lane, utility module, script, or migration, in any worktree or phase: commit-scoped reviews must never audit their own author, and ChatGPT usage limits are reserved for judgment, not keystrokes. Where Codex consults influence landed work (adversarial scenarios, recovery diagnoses, design-review findings), the phase log records provenance in one line each; the Phase 18 readiness review audits that no phase-commit review covered Codex-originated artifacts beyond triaged review findings.
- Budget rule: mandatory calls (phase-commit reviews, the single re-review, checkpoint reviews) have absolute priority. Discretionary calls (design red-teams, adversarial scenario consults, recovery consults, pre-deletion audit, screenshot passes) are capped at ONE per phase, must not launch while a mandatory review is pending or deferred for cap reasons, get zero retries, and are always skippable — nothing in the acceptance criteria depends on them. If any call hits a usage limit, all discretionary use suspends until the next mandatory call succeeds (recorded in the Resume Snapshot). Degradation order when limits bite, cut from the top: screenshot judging → adversarial scenario consults → pre-deletion audit → design red-teams → recovery consults → low-risk phase reviews (fallback chain) → never the high-risk phase or checkpoint reviews.
- Call ledger: the execution log Environment section gains an append-only Codex Calls table (date | purpose | effort | duration | outcome). Every codex invocation of any kind is logged.
- Discretionary-call hardening: same invocation discipline as the mandatory gate — absolute codex path, background task registered in the Resume Snapshot, stdout to `docs/superpowers/reviews/codex/`, hard timebox stated at launch (20 min recovery consult, 30 min screenshot pass, 45 min design red-team), terminated via the tracked task id on timeout, never pattern kills. Flag experiments (`--output-schema`, `-i`, session resume) happen on discretionary calls only — never change the mandatory review invocation mid-run.

Discretionary Codex uses (adopted set — nothing else without a Decision Ledger entry):

1. Design red-team (Phases 9 and 10; 2 calls, xhigh, 45-min timebox): after the judges select a winning design and BEFORE implementation lanes launch, run `codex exec` (read-only sandbox) over the winning doc in `docs/architecture/` plus the Non-Negotiables and the named failure scenarios, prompted for data-loss holes, ordering/idempotency flaws, hand-waved failure scenarios, and simpler alternatives. Findings go through the standard triage→verify→fix-or-reject pipeline before lane briefs are issued; the design doc gains a Red-team Findings section. While it runs the lead does only read-only phase prep. On failure/timeout, fold the design questions into that phase's commit-review prompt and proceed. Codex never authors judge-panel candidates — all candidates are Claude subagents; cross-model input enters only here, post-verdict.
2. Adversarial scenario consult (post-Phase-4 checkpoint: IPC validation; Phase 10: the six data-loss cases; post-Phase-11 checkpoint: MCP path scoping; 3 calls, high effort): `codex exec` read-only, prompted to ENUMERATE concrete attack/loss scenarios (inputs, sequence, expected invariant violation) — output is scenario descriptions, never test files or repo writes. The lead transcribes chosen scenarios into owned tests under normal TDD (recorded RED required), discards duplicates per the code-size rules, and logs which landed scenarios were Codex-origin. A scenario asserting behavior that contradicts the plan's contracts is rejected with reasoning, never satisfied by weakening the implementation.
3. Recovery consult (rare; see Recovery Protocol): one bounded fresh-model diagnosis before any blocked declaration or Phase 16 deferral.
4. Pre-deletion audit (Phase 13, 1 call, xhigh): see Phase 13 Step 2.5.
5. Advisory screenshot pass (Phases 3 and 18 only; 2 calls, high effort, via `-i` attachments; conditional on the Phase 0 `-i` preflight): score ≤8 representative PNGs against the Design Review Loop rubric verbatim. Strictly advisory — the Claude design-review subagent remains the sole gating judge. Hard-item disagreements are re-examined once by the lead against the actual pixels before the phase commit; soft-item disagreements become deferred findings for the Phase 18 re-judge. On `-i` error or timeout, skip silently.

### Parallel Lane Contract

Intra-phase implementation fan-outs are allowed only under these rules:

- Only the lead runs `pnpm add`/`pnpm install` and touches `pnpm-lock.yaml`/root `package.json`. Before fanning out, the lead scaffolds new package stubs and installs declared dependencies once; lanes never modify the lockfile.
- Lanes never write the execution log or this plan. Each lane returns a structured report (files changed, tests added, RED output, GREEN output, deletions, open questions) that the lead merges into the log.
- Every lane brief is self-contained (lanes share no conversation memory): phase goal, exact files owned, the TDD requirement (failing test recorded before implementation), file-ownership boundary, exact test commands, relevant Non-Negotiables. Never reference "as discussed above."
- File-mutating lanes are worktree-isolated. The lead merges lanes, regenerates the lockfile once if needed, runs the phase's combined test commands, then commits.

Per-phase parallelism map:

```txt
Phase 0:  fan out read-only explorers (one per required digest + one per existing package classification); baseline runs in background.
Phase 1:  none — single lead lane (tiny phase, shared scaffolding).
Phase 2:  none — single lead lane (coupled security posture). t3code recon fan-out may start here.
Phase 3:  implementation single-lane (shared shell/CSS). Fan out only read-only work: t3code recon, screenshot capture, design judges.
Phase 5:  lead defines watcher-event/change-set contracts first, then 3 worktree TDD lanes: A=workspace-fs watch/scan/diff, B=workspace-sync batchedSync, C=workspace-history changeSetStore. Lead-owned tail: shell wiring (shared DesktopWorkspaceShell.tsx).
Phase 6:  lead writes failing fileTypes E2E + scaffolds FileInspector as dispatch table with one file per view; optional 2-4 lanes by affinity (text/data, media, SQLite studio, app affordance). Skip fan-out if moving fast single-lane.
Phase 9:  start `pnpm dev:postgres` in background at phase start. After judge panel: Lane A=Better Auth (services/workspace-api), Lane B=sync protocol+backend (workspace-sync, workspace-postgres; stub actor shape from fixed ResolveActor contract), Lane C=compose/docs. Lane D (CloudLogin + E2E) starts after Lane A lands — dependency-ordered. cloudSync E2E runs last against background dev server.
Phase 10: after judge panel: Lane A=collaborationPolicy (workspace-sync), Lane B=conflictResolution (workspace-history), Lane C=postgres-acl (hocuspocus). Lead-owned tail: useCollabDoc, sync UI, both E2E specs (two-client E2E in background).
Phase 12: none — global rename is single-agent by nature.
Phase 13: Step 1 fans out one read-only verifier per ported-test-map row (locate test, run it, confirm it fails when implementation is stubbed). Steps 3-5 deletion is explicitly single-agent (global lockfile/import surgery). Post-deletion battery in background.
Phase 14: optional 2 lanes: A=update state machine, B=builder config+smoke+docs. Packaging build in background.
Phase 15: fan out one doc-writer per document (5 lanes, self-contained briefs incl. product-shape bullets + thesis + phase outcomes). Lead writes the check script; smokes in background.
Phase 16: measurement runs require quiescence (below). Optimization fixes MAY lane per disjoint target; authoritative re-measure on merged tree, quiesced.
Phase 17: discovery findings partitioned across read-only classifiers; consolidation rows lane per owner package when duplicate sites are disjoint. Verification battery sequential-in-background.
Phase 18: none — the readiness E2E is one intentionally sequential flow.
```

### Background/Foreground Rules

ALWAYS background (registered in Resume Snapshot, with completion notification): docker compose stacks; workspace-api/hocuspocus/web dev servers (never foreground — WSL safety); the baseline script; full `pnpm -r` test/typecheck; full `pnpm test:desktop:e2e`; electron-builder packaging; `pnpm check:self-host`; Phase 17/18 verification batteries; all `codex exec review` runs; the two-client liveCoEditing E2E.

ALWAYS foreground: the TDD inner loop's targeted commands — single-package vitest runs, single-spec Playwright runs, single-package typechecks. The red/green cycle needs immediate feedback.

Phase-end full regression goes background while the lead does the delete-or-justify pass and log update; the commit waits for the background green.

Measurement quiescence: before any measured performance run (Phase 2 launch marks onward, especially performance.spec.ts), drain or pause all background tasks, parallel subagents, and Codex reviews; verify no docker build/test suite is running; record the quiesced state in the log. Perf measurement owns the machine.

### Checkpoint Review Recipe

1. Lead computes `git diff --stat main...HEAD` and writes a 10-line range summary into the log.
2. Fan out one read-only finder per relevant lens (security, authz/collab, data-loss/deletion-safety, performance, over-engineering/code-size). Each brief is self-contained: repo path, branch, diff command, lens definition copied from Non-Negotiables, output format per finding: {claim, evidence file:line, severity, repro command, proposed fix}. Cap 10 highest-confidence findings per finder.
3. Launch the Codex `--base main` review in parallel (background); merge its findings into the same pipeline.
4. Lead dedupes; one fresh verifier per candidate finding, given ONLY the finding text and repo (not the finder's reasoning), must confirm by repro or exact code citation. Unconfirmed → rejected-with-reason. Verifiers are always Claude subagents; Codex participates in checkpoints only as a finder via the `--base main` review, and Codex findings are verified by non-Codex verifiers like any other finding.
5. Fix confirmed findings with targeted tests; re-run affected suites.
6. Stop rule: max 2 rounds, or stop early when a round yields zero new confirmed medium+ findings.

### Verifier Task Contracts (per-phase, before phase-closing commit)

- Claimed-vs-actual: input = phase plan section + commit range + log entry; method = re-run every command the log claims passed, check every checkbox against the diff; output = table of claim / evidence command / verdict (confirmed | unsupported | contradicted).
- Test-quality: method = disposable `git worktree add`, revert all non-test files in the phase range there, run the phase's test commands, expect failure; output = list of tests that still pass without the implementation (each is a finding). NEVER mutate the lead's checkout.
- Screenshot review: input = the Design Review Loop rubric + the fixed artifact glob `test-results/screenshots/phase-<NN>/`; output = per-rubric-item pass/fail with offending screenshot path.

### Recovery Protocol

- Flaky test: re-run the single failing spec in isolation once to classify. Pass-on-retry = flake — deflake in the same phase by replacing sleeps/races with event-driven waits (performance marks, IPC signals); max 3 attempts, then quarantine the spec with a log entry and a mandatory item at the next checkpoint. NEVER add Playwright `retries:`, broaden timeouts beyond 2x, or weaken assertions to mask flake.
- External service down (Postgres, minio, hocuspocus): the lead is authorized to start/restart via the documented compose commands (background, per WSL safety — no pattern kills). Not a blocker. An ECONNREFUSED/timeout from a service port is an environment failure, never a test failure; fix the environment, never the test.
- Electron launch failure on this machine: the fix is ALWAYS environmental, never webPreferences (see Phase 2).
- Toolchain freeze: Phase 0 records `node -v`, `pnpm -v`, and `command -v codex` in the Environment section. Tests must run under the Node version that reproduces the dual-backend green sweep (22.13.0 verified — Node 25 breaks 17 web tests); pin via PATH prefix in scripts, do not run `nvm use` mid-run. Codex is invoked by absolute path.
- Fresh-model consult (required before declaring blocked): when the same blocker survives three concrete attempts, or a Phase 16 metric is still over budget after its 3 optimization attempts, the lead writes a self-contained brief to `docs/superpowers/reviews/codex/blocker-<phase>-<slug>.md` (symptom, exact failing command, path to full output, files inspected, the three attempts and why each failed) and makes ONE `codex exec` consult — read-only sandbox, xhigh, 20-minute timebox, backgrounded — asking for the most likely root cause and the smallest concrete fix or next experiment. Rules: this is attempt 4-of-4, never a counter reset; any proposed diagnosis must be independently confirmed by the lead via repro or exact code citation before any code change; if Codex is unavailable or the timebox expires, proceed directly to the blocked report (zero retries). The diagnosis file is attached to any blocked report. This consult is exempt from the per-phase review budget but logged in the call ledger.

### Major Review Checkpoints

Use Codex third-party review plus multi-agent adversarial review workflows (and manual review if the user is present):

- after Phase 4: Electron security and IPC review.
- after Phase 7: local workspace/sync review.
- after Phase 9: cloud sync/collaboration review.
- after Phase 10: merge/data-loss and live co-editing review.
- after Phase 11: MCP/agent-power review.

exec
/bin/bash -lc "grep -n \"## Phase 1\\|Phase 1\" docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md | head -20" in /home/ice/dev/dohc
 succeeded in 0ms:
185:4. Fix every fail and re-run the loop. Maximum 3 iterations per UI phase. Hard items (text overflow, occluded controls, blank render, marketing chrome, palette drift from tokens) block the phase unconditionally. Soft aesthetic items still failing after 3 iterations become explicit deferred findings with screenshots in the execution log, re-judged at the Phase 18 readiness review.
221:dohc Desktop is the antithesis of Notion-class bloated Electron apps. Slowness is a bug, not polish debt. These rules apply to every phase, not just Phase 16:
232:Continuous enforcement (do not defer performance to Phase 16):
236:- Phase 16 formalizes budgets into the hard `check:performance` gate and ratchets existing measurements — it must not be the first time a number is seen.
245:- Deletion is part of every phase's definition of done, not a Phase 17 sweep. When a replacement lands with passing tests, the replaced path dies in the same phase. Phase 17 is the final audit, not where deletion starts.
325:- Design judge panels: before implementing the sync protocol (Phase 9) and the conflict/co-editing model (Phase 10), generate at least 3 independent designs and score them with parallel judges against concrete failure scenarios: concurrent edit, offline rename, half-written file, watcher storm, clock skew, partial upload, reconnect-after-divergence. Each candidate is a doc with fixed sections: data model, message/protocol flow, behavior under each named failure scenario, estimated LOC and new dependencies, what it deletes. Judges receive identical briefs (candidate docs + Non-Negotiables + sync payload list + settle windows + perf budgets) and output a scored matrix (scenario × design, 0-2) plus a one-paragraph verdict. The winning design goes to `docs/architecture/` (losing designs and fatal flaws included); the Decision Ledger gets a one-line entry.
334:- Effort tiering: checkpoint `--base main` reviews, per-phase reviews for security/sync/data-loss/deletion phases (2, 4, 5, 9, 10, 11, 13), design red-teams, the Phase 13 pre-deletion audit, and recovery consults run at `model_reasoning_effort="xhigh"`. Per-phase reviews for low-risk phases (0, 1, 12, 14, 15), adversarial scenario consults, and screenshot judging run at `"high"`. Remaining phases default to xhigh.
337:- At every major checkpoint: run `codex exec review -m gpt-5.5 -c model_reasoning_effort="xhigh" --base main` (checkpoints are always xhigh) over the cumulative branch diff with targeted questions for that checkpoint's risk area (e.g., IPC validation at Phase 4, merge/data-loss at Phase 10, deletion completeness at Phase 13).
347:- Independence rule: Codex never reviews an artifact Codex authored or materially shaped. Codex authors no code, no tests, and no candidate designs in this repo — its only write target is its own transcript under `docs/superpowers/reviews/codex/`. Codex is never assigned an implementation lane, utility module, script, or migration, in any worktree or phase: commit-scoped reviews must never audit their own author, and ChatGPT usage limits are reserved for judgment, not keystrokes. Where Codex consults influence landed work (adversarial scenarios, recovery diagnoses, design-review findings), the phase log records provenance in one line each; the Phase 18 readiness review audits that no phase-commit review covered Codex-originated artifacts beyond triaged review findings.
355:2. Adversarial scenario consult (post-Phase-4 checkpoint: IPC validation; Phase 10: the six data-loss cases; post-Phase-11 checkpoint: MCP path scoping; 3 calls, high effort): `codex exec` read-only, prompted to ENUMERATE concrete attack/loss scenarios (inputs, sequence, expected invariant violation) — output is scenario descriptions, never test files or repo writes. The lead transcribes chosen scenarios into owned tests under normal TDD (recorded RED required), discards duplicates per the code-size rules, and logs which landed scenarios were Codex-origin. A scenario asserting behavior that contradicts the plan's contracts is rejected with reasoning, never satisfied by weakening the implementation.
356:3. Recovery consult (rare; see Recovery Protocol): one bounded fresh-model diagnosis before any blocked declaration or Phase 16 deferral.
357:4. Pre-deletion audit (Phase 13, 1 call, xhigh): see Phase 13 Step 2.5.
358:5. Advisory screenshot pass (Phases 3 and 18 only; 2 calls, high effort, via `-i` attachments; conditional on the Phase 0 `-i` preflight): score ≤8 representative PNGs against the Design Review Loop rubric verbatim. Strictly advisory — the Claude design-review subagent remains the sole gating judge. Hard-item disagreements are re-examined once by the lead against the actual pixels before the phase commit; soft-item disagreements become deferred findings for the Phase 18 re-judge. On `-i` error or timeout, skip silently.
373:Phase 1:  none — single lead lane (tiny phase, shared scaffolding).
379:Phase 10: after judge panel: Lane A=collaborationPolicy (workspace-sync), Lane B=conflictResolution (workspace-history), Lane C=postgres-acl (hocuspocus). Lead-owned tail: useCollabDoc, sync UI, both E2E specs (two-client E2E in background).
380:Phase 12: none — global rename is single-agent by nature.
381:Phase 13: Step 1 fans out one read-only verifier per ported-test-map row (locate test, run it, confirm it fails when implementation is stubbed). Steps 3-5 deletion is explicitly single-agent (global lockfile/import surgery). Post-deletion battery in background.
382:Phase 14: optional 2 lanes: A=update state machine, B=builder config+smoke+docs. Packaging build in background.
383:Phase 15: fan out one doc-writer per document (5 lanes, self-contained briefs incl. product-shape bullets + thesis + phase outcomes). Lead writes the check script; smokes in background.
384:Phase 16: measurement runs require quiescence (below). Optimization fixes MAY lane per disjoint target; authoritative re-measure on merged tree, quiesced.

exec
/bin/bash -lc "grep -n \"Local.*workspace core\\|workspace core\\|contract\" docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md | head -80" in /home/ice/dev/dohc
 succeeded in 0ms:
45:- t3code's desktop package is a useful pattern: explicit desktop package, main/preload separation, desktop bridge contract, desktop auth/bootstrap, update tests, smoke tests, and release artifact scripts.
76:- `packages/workspace-contracts`
355:2. Adversarial scenario consult (post-Phase-4 checkpoint: IPC validation; Phase 10: the six data-loss cases; post-Phase-11 checkpoint: MCP path scoping; 3 calls, high effort): `codex exec` read-only, prompted to ENUMERATE concrete attack/loss scenarios (inputs, sequence, expected invariant violation) — output is scenario descriptions, never test files or repo writes. The lead transcribes chosen scenarios into owned tests under normal TDD (recorded RED required), discards duplicates per the code-size rules, and logs which landed scenarios were Codex-origin. A scenario asserting behavior that contradicts the plan's contracts is rejected with reasoning, never satisfied by weakening the implementation.
376:Phase 5:  lead defines watcher-event/change-set contracts first, then 3 worktree TDD lanes: A=workspace-fs watch/scan/diff, B=workspace-sync batchedSync, C=workspace-history changeSetStore. Lead-owned tail: shell wiring (shared DesktopWorkspaceShell.tsx).
378:Phase 9:  start `pnpm dev:postgres` in background at phase start. After judge panel: Lane A=Better Auth (services/workspace-api), Lane B=sync protocol+backend (workspace-sync, workspace-postgres; stub actor shape from fixed ResolveActor contract), Lane C=compose/docs. Lane D (CloudLogin + E2E) starts after Lane A lands — dependency-ordered. cloudSync E2E runs last against background dev server.
546:  desktop-bridge-contracts/ # typed preload IPC contract and zod schemas
603:- Keep/promote: `workspace-postgres`, `workspace-fs`, `workspace-api`, `agent-sandbox`, `sqlite-worker`, `app-tester`, `workspace-contracts` concepts.
623:  ["pnpm", ["--filter", "@dohc/workspace-contracts", "test"]],
719:- [ ] **Step 4: Implement workspace core**
748:Record in the execution log which old workspace contract types move into `workspace-core` and which remain temporarily in `workspace-contracts`.
754:git commit -m "Add local-first workspace core contract"
1210:uploads/contract.pdf
2229:IPC schemas -> desktop-bridge-contracts or apps/desktop/src/ipc

exec
/bin/bash -lc "sed -n '500,770p' docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md" in /home/ice/dev/dohc
 succeeded in 0ms:
- Resume notes: (one sentence: what is half-done, exact next command)
- Files changed:
- Code deleted or consolidated:
- Net LOC delta (`git diff --shortstat`):
- Old paths retained and why:
- Dependencies added (name, size, justification):
- Decisions made (D-NN ids):
- Tests added:
- Commands run:
- Failing tests fixed:
- Electron E2E/manual smoke:
- UI/UX screenshot/design review:
- Performance measurements: (compact table rows, not prose)
- Security/collaboration regressions:
- Reviewer/subagent findings: (numbered one-liners, status: fixed @ sha | rejected: reason)
- Codex third-party review findings: (one-liners + pointer to docs/superpowers/reviews/codex/phase-NN.md)
- Relevant findings fixed:
- Deferred findings with reason:
- Remaining risk:
- Next phase:
```

Log update cadence and hygiene (mandatory):

- Update the Resume Snapshot at every TDD-step transition, before launching anything long-running (codex review, full suite, fan-out, worktree), and immediately after every commit. Register background tasks and worktrees in the snapshot BEFORE launching; clear entries on completion/merge. On resume, reconcile the snapshot against `git status`, `git worktree list`, and on-disk artifacts before doing anything else.
- The log is append-only except the Resume Snapshot.
- No raw command output, stack traces, or codex transcripts over ~10 lines — write full output to `test-results/` or `docs/superpowers/reviews/codex/phase-NN.md` and link the path.
- Soft cap ~80 lines per phase section; overflow goes to a per-phase appendix file.
- The resume read-set is: Resume Snapshot + Environment + Decision Ledger + Gotchas + Reference Digests + the current phase's section ONLY.

## Planned Repository Shape

Target shape after this plan:

```txt
apps/
  desktop/                  # Electron main/preload/app shell, desktop-first product
  web/                      # Web/cloud/shared-link client; may be renamed from apps/app
  mobile-web/               # optional later; not required in this plan

packages/
  workspace-core/           # local-first workspace model, modes, paths, change sets
  workspace-fs/             # existing package promoted: watch/materialize/scan/diff/apply
  workspace-postgres/       # existing package promoted: cloud/self-host store
  workspace-sync/           # local <-> cloud sync engine
  workspace-history/        # dohc-native change sets/provenance/conflict summaries
  desktop-bridge-contracts/ # typed preload IPC contract and zod schemas
  mcp/                      # dohc MCP server for Codex/Claude Code

services/
  workspace-api/            # cloud/self-host API over Postgres
  hocuspocus/               # collaborative text where needed
  sqlite-worker/            # SQLite import/materialization/query
  app-tester/               # app quality/runtime testing
  agent-sandbox/            # hosted/cloud sandbox; desktop local agents use folder+MCP first

docs/
  architecture/
  self-hosting.md
  desktop.md
```

The implementer may keep `apps/app` temporarily, but the plan should end with a clear `apps/desktop` and `apps/web` split or a documented reason why a safe rename must wait.

---

## Phase 0: Baseline, Tooling, And Old-Plan Inventory

**Files:**

- Create: `docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md`
- Create: `docs/superpowers/reviews/2026-06-10-old-plan-port-delete-inventory.md`
- Create: `scripts/check-desktop-local-first-baseline.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write execution log**

Create the execution log using the template above.

- [ ] **Step 2: Write old-plan inventory**

Create `docs/superpowers/reviews/2026-06-10-old-plan-port-delete-inventory.md` with:

```md
# Old Plan Port/Delete Inventory

## Keep And Promote

## Port With Changes

## Delete After Replacement

## Delete Immediately

## Tests To Preserve

## Tests To Rewrite

## Remaining Questions
```

Minimum classifications:

- Keep/promote: `workspace-postgres`, `workspace-fs`, `workspace-api`, `agent-sandbox`, `sqlite-worker`, `app-tester`, `workspace-contracts` concepts.
- Port with changes: uploads/file-type views, app runtime, agent output separation, backend matrix.
- Delete after replacement: Convex backend, Convex compat package, dual-backend switch, web-first atom tools, `.views` compatibility.
- Rewrite: backend matrix should become desktop/local/cloud matrix.

- [ ] **Step 3: Add baseline check**

Create `scripts/check-desktop-local-first-baseline.mjs`:

```js
import { spawnSync } from "node:child_process";

const env = {
  ...process.env,
  PATH: process.env.PATH ?? "",
};

const commands = [
  ["pnpm", ["--filter", "@dohc/web", "typecheck"]],
  ["pnpm", ["--filter", "@dohc/web", "test"]],
  ["pnpm", ["--filter", "@dohc/workspace-contracts", "test"]],
  ["pnpm", ["--filter", "@dohc/workspace-postgres", "test"]],
  ["pnpm", ["--filter", "@dohc/workspace-fs", "test"]],
  ["pnpm", ["--filter", "@dohc/workspace-api", "test"]],
  ["pnpm", ["--filter", "@dohc/app-tester", "test"]],
  ["pnpm", ["--filter", "@dohc/sqlite-worker", "test"]],
  ["pnpm", ["--filter", "@dohc/agent-sandbox", "test"]],
  ["pnpm", ["check:debt"]],
];

for (const [cmd, args] of commands) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: true, env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
```

- [ ] **Step 4: Register script**

Add:

```json
"check:desktop-local-first-baseline": "node scripts/check-desktop-local-first-baseline.mjs"
```

- [ ] **Step 5: Environment preflight, then run baseline**

Preflight first: start `pnpm dev:postgres` as a background task and poll readiness (bounded, ~60s max); record `node -v`, `pnpm -v`, and `command -v codex` in the execution log Environment section (toolchain freeze — tests run under Node 22.13.0 via PATH prefix; Node 25 breaks 17 web tests); record display server state. The baseline script must pin the test Node via PATH.

Codex capability preflight (one cheap call each, recorded in Environment): verify `codex exec review` works; verify plain `codex exec` completes under a read-only sandbox; verify `-i` correctly describes a known test PNG. If optional capabilities (`codex exec`, `-i`) fail, disable only the discretionary uses needing them. If `codex exec review` or the preferred model itself fails, the review gate is NOT disabled — it switches to the independent-review fallback chain from the Codex third-party review section, recorded in the execution log.

```bash
pnpm check:desktop-local-first-baseline
```

Run as a background task. Expected: pass, or execution log records exact pre-existing failures. An ECONNREFUSED from Postgres is an environment failure — fix services, do not record it as a pre-existing test failure.

The Step 2 inventory may fan out read-only explorer subagents (one per existing package/service, one per digest doc) per the parallelism map; the inventory must record exact file paths for app runtime, upload, and file-type code so later phases cite paths, not memories.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/check-desktop-local-first-baseline.mjs docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md docs/superpowers/reviews/2026-06-10-old-plan-port-delete-inventory.md
git commit -m "Inventory old plan for desktop local-first pivot"
```

---

## Phase 1: Local-First Workspace Core Contract

**Files:**

- Create: `packages/workspace-core/package.json`
- Create: `packages/workspace-core/tsconfig.json`
- Create: `packages/workspace-core/src/workspaceMode.ts`
- Create: `packages/workspace-core/src/paths.ts`
- Create: `packages/workspace-core/src/metadata.ts`
- Create: `packages/workspace-core/src/changeSet.ts`
- Create: `packages/workspace-core/src/conflicts.ts`
- Create: `packages/workspace-core/src/index.ts`
- Create: `packages/workspace-core/src/workspaceMode.test.ts`
- Create: `packages/workspace-core/src/paths.test.ts`
- Create: `packages/workspace-core/src/changeSet.test.ts`

- [ ] **Step 1: Write failing workspace mode tests**

Tests must assert:

```ts
expect(defaultWorkspaceMode("personal")).toBe("local-first");
expect(defaultWorkspaceMode("shared")).toBe("cloud-first-local-copy");
expect(defaultWorkspaceMode("cloud-only")).toBe("cloud-only");
```

Also assert workspace mode is per-workspace, not per-file.

- [ ] **Step 2: Write failing path tests**

Tests must assert:

- `~/dohc` is the default root suggestion.
- attached folders are allowed.
- `.dohc/manifest.json` is reserved.
- path traversal is rejected.
- `.apps/<name>/app.json` is a visible app source path.
- `.sqlite`, `.sqlite3`, and `.db` are visible database files.

- [ ] **Step 3: Write failing change-set tests**

Tests must assert:

- one agent run editing many files groups into one change set.
- normal allowed edits do not require approval.
- boundary crossings require review: public share, permission change, bulk delete, app trust/install, private-to-shared move.
- conflicts produce human-readable summaries, not Git markers.

- [ ] **Step 4: Implement workspace core**

Implement:

```ts
export type WorkspaceMode = "local-first" | "cloud-first-local-copy" | "cloud-only";
export type WorkspaceKind = "personal" | "shared" | "cloud-only";
export type ChangeSetKind = "user-edit" | "agent-run" | "import" | "sync" | "app-build";
export type BoundaryCrossing =
  | "public-share"
  | "external-export"
  | "permission-change"
  | "bulk-delete"
  | "app-trust"
  | "private-to-shared"
  | "unmergeable-overwrite";
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @dohc/workspace-core test
pnpm --filter @dohc/workspace-core typecheck
```

Expected: pass.

- [ ] **Step 6: Delete-or-justify**

Record in the execution log which old workspace contract types move into `workspace-core` and which remain temporarily in `workspace-contracts`.

- [ ] **Step 7: Commit**

```bash
git add packages/workspace-core package.json pnpm-lock.yaml docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md
git commit -m "Add local-first workspace core contract"
```

---

## Phase 2: Electron Desktop Scaffold And Test Harness

**Files:**

- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/electron.vite.config.ts`
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/preload.ts`
- Create: `apps/desktop/src/ipc/channels.ts`
- Create: `apps/desktop/src/ipc/bridgeContract.ts`
- Create: `apps/desktop/src/window/createMainWindow.ts`

exec
/bin/bash -lc "sed -n '1,220p' docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md" in /home/ice/dev/dohc
 succeeded in 0ms:
# Desktop Local-First Cloud Sync Execution Log

## Resume Snapshot (overwrite in place — the ONLY mutable section)

- Phase/Step + TDD position: Phase 1 COMPLETE (committed 67d692f, codex review in flight); Phase 2 read-only prep underway
- Expected test state: workspace-core 31/31 green; baseline green (11 PASS + 1 KNOWN-FAIL web)
- Dirty files and intent: this log only (snapshot updates)
- Exact next action: when codex phase-01 review lands → triage → then Phase 2 Step 1 (pnpm-workspace.yaml onlyBuiltDependencies, install Electron tooling, verify electron --version) — mutation waits for review triage
- Active background tasks: codex review phase-01 (bbslcyw98 → docs/superpowers/reviews/codex/phase-01.md); t3code renderer recon agent (digest → Reference Digests on completion)
- Open worktrees: none
- Pending reviews: codex phase-01 (in flight)

## Environment (append-only)

- Toolchain freeze: tests run under Node v22.13.0 via PATH prefix `/home/ice/.local/share/nvm/v22.13.0/bin:/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin:$PATH`. Shell default is Node v25.2.1 — Node 25 breaks 17 @dohc/web tests (verified 2026-06-10: AtomEditor.lifecycle suite 13/13 fail on 25, 13/13 pass on 22.13). Never run `nvm use`.
- pnpm 10.24.0 (packageManager pin).
- Codex: `/home/ice/.local/share/nvm/v25.2.1/bin/codex` (codex-cli 0.130.0, ChatGPT auth). Verified: `exec` read-only sandbox + `-m gpt-5.5 -c model_reasoning_effort="xhigh"` works (2026-06-10, 15.2K tokens). `gpt-5.5-fast` NOT available on this auth. Second install exists at `/mnt/c/Users/ice/.codex/bin/wsl/81645c5d269e0fb2/codex` (0.137.0-alpha.4, found by team audit) — using the verified 0.130.0; revisit only if review subcommand misbehaves.
- Display: WSL2 + WSLg (DISPLAY=:0, WAYLAND=wayland-0); xvfb-run available as fallback.
- Docker 29.5.2. Services healthy: dohc-v2-postgres, dohc-v2-minio, dohc-v2-hocuspocus (compose: docker-compose.dev.yml).
- WSL safety: never pattern-kill node/pnpm/vite/etc.; servers always background tasks; kill only tracked task ids.

### Codex Calls ledger (date | purpose | effort | duration | outcome)

- 2026-06-10 | preflight exec read-only smoke ("OK") | xhigh | ~1min | success
- 2026-06-10 | preflight gpt-5.5-fast probe | xhigh | ~10s | model rejected on ChatGPT auth (expected)
- 2026-06-10 | preflight -i image (arg-prompt form) | low | ~5s | FAILED: positional prompt not parsed with -i in detached-stdin context
- 2026-06-10 | preflight -i image (stdin `-` form) | low | ~1min | success — correctly described dohc avatar; -i capability VERIFIED
- 2026-06-10 | phase 0 review --commit+prompt (x2: 0.130 and 0.137 binaries) | high | ~5s each | FAILED: --commit rejects custom prompt; pattern corrected in plan
- 2026-06-10 | phase 0 review --commit 7df1553 promptless | high | ~7min | success — 3 P2 findings on baseline script, all confirmed real, all fixed

## Decision Ledger (append-only)

- D-01 | Better Auth inside workspace-api (Drizzle/pg, organization + deviceAuthorization plugins); WorkOS deferred as enterprise SSO path behind Better Auth | self-host needs vendor-free auth; WorkOS bridge stays open | pre-phase
- D-02 | Live co-editing (Yjs/Hocuspocus) in scope; hocuspocus convex-acl → postgres-acl | user decision | pre-phase
- D-03 | Single mega-branch `claude/desktop-local-first-cloud-sync`, green-milestone commits `phaseN(step M):`, no squash | user decision + resumability | pre-phase
- D-04 | Native orchestration replaces superpowers skill (lanes, judge panels, verifier fan-outs, checkpoint recipe) | skill unavailable; codified in plan | pre-phase
- D-05 | Codex = independent third-party reviewer with effort tiering, budget ledger, fallback chain; NEVER authors code/tests/designs | independence is the value; panel + team audit | pre-phase
- D-06 | Node 22.13.0 frozen for tests; codex by absolute path | Node 25 breaks 17 web tests; PATH drift | pre-phase
- D-07 | CRDT canonical while shared file open, filesystem canonical while closed; 6 named data-loss cases must be tested | team audit + plan amendment | pre-phase
- D-08 | dual-backend code lives in main at bc62bd2; stale local branch of same name must never be used | recon | pre-phase

## Reference Digests (append-only)

### Dual-backend branch digest (source: 2026-06-09 execution log + readiness review + tech-debt audit; digested 2026-06-10)

- All 9 packages/services mature and tested: workspace-contracts (conformance harness, 8 tests), workspace-postgres (Drizzle schema/migrations/repos/services, 12 tests, dev-ready, zero Convex coupling), workspace-fs (materialize/scan/diff/apply/syncClient/watch — watch is POLLING, 6 tests), workspace-api (HTTP handler + ResolveActor at src/auth/session.ts, 1 test, no production listener), agent-sandbox (allowlist shell, diff capture, 2+4 tests), sqlite-worker (11 tests; needs node:sqlite ⇒ Node 22.13+), app-tester (25 tests, backend matrix), hocuspocus (78 tests, Convex-coupled ACL), workspace-convex-compat (conformance-only consumer: workspace-contracts tests).
- Final sweep: 1619 web tests passed under Node 22.13. Postgres pkg tests need `--no-file-parallelism` (shared DB fixture).
- Production gates NOT done (this plan's work): hosted auth, live Yjs over Postgres, migration, deployment, observability.
- Known debt w/ deletion conditions: .views compat (until indexed discovery + regression tests), confirmTier/views/entities mode comments, dual-backend switch (until Postgres default), convex-compat (until Convex off production).
- Gotchas: pnpm install required after adding new packages (symlinks); MinIO image pinned; sync apply sequential (no idempotency keys yet); approval surfacing partial (errors not cards); upsertAtomImpl adds frontmatter — corrupts non-markdown bodies (use deriveSearchFields for text files); sandbox guards are arg-level, not namespace isolation.

### Convex usage map digest (source: apps/app/convex + repo grep; digested 2026-06-10)

- Auth: WorkOS AuthKit via `@convex-dev/workos-authkit`; client bridge apps/app/src/lib/use-auth-bridge.ts + ConvexProviderWithAuth in routes/__root.tsx; server auth.config.ts (WorkOS RS256 issuer, env WORKOS_CLIENT_ID); actor = ctx.auth.getUserIdentity() {subject, email, name, tokenIdentifier}; requireWorkspace(ctx, activeWorkspaceId) checks memberships.
- Convex function surface: ~40 modules — auth, schema (atoms/atomShares/atomLocks/memberships/orgs/workspaceAssets/databaseFiles/...), agent.ts (@convex-dev/agent tools), hocuspocusAuth.ts (ACL queries: checkAtomAccess/loadAtomBootstrap/setBodyCache/createAtom), atoms/atomAccess/atomShares, assets (storage upload URLs), databaseFiles/databaseOps, apps/appAgent/appTesting/appTrust, views/windows, trash, captures, crons (purges), search.
- Non-convex importers: apps/app/src/lib/convex-client.ts, use-auth-bridge.ts, routes/__root.tsx, components/Chat.tsx (+chat-optimistic), routes/r/$atomId.tsx (share SSR); services/hocuspocus/src/convex-acl.ts + server.ts (env HOCUSPOCUS_CONVEX_URL + HOCUSPOCUS_CONVEX_SERVER_TOKEN); packages/workspace-convex-compat/testAdapter.ts.
- convex-acl.ts exports createConvexAcl(): getWorkspaceAuthzVersion/canReadAtom/canWriteAtom/loadAtomBootstrap/setAtomBodyCache/createAtom — Postgres port must replicate these against workspace-postgres grants + Better Auth sessions.
- Env to delete in P13: CONVEX_DEPLOYMENT, VITE_CONVEX_URL, VITE_CONVEX_SITE_URL, WORKOS_*, HOCUSPOCUS_CONVEX_*; scripts: dev-sync.mjs convex parts, reset:dev.
- Convex guidelines key porting rules: server-derived identity only (never trust client identity args); index-based queries (no .filter); storage = Blob + signed URLs; crons via crons.interval/cron; validators on every function.

### Port-source file paths (verified present 2026-06-10)

- File-type views: apps/app/src/components/FileTypeView.tsx; Database Studio: DatabaseStudio.tsx, DatabaseTableGrid.tsx; tree: FileTree.tsx; upload: UploadFileButton.tsx; agent activity: AgentActivityTimeline.tsx, AgentRunRail.tsx (+ AgentChatSidebar.tsx).

## Gotchas (append-only)

- Node 25 breaks 17 @dohc/web tests; pin 22.13.0 via PATH (see Environment).
- workspace-postgres tests: shared local DB fixture, not file-parallel.
- pnpm 10 ignores postinstall — Electron needs onlyBuiltDependencies in pnpm-workspace.yaml BEFORE install (Phase 2).
- Root playwright.config.ts is web-only (testDir apps/app/e2e + webServer); desktop gets own config.
- check:debt bans the literal deferred-work marker tokens it scans for, in any file including docs — never write them, even when describing the rule itself (this line was rewritten once for exactly that reason).
- Package named @dohc/web already, but lives at apps/app (Phase 12 renames path).
- ECONNREFUSED from :5432/:9000/:1234 = environment failure, never a test failure.
- codex exec with `-i`: pass the prompt via stdin pipe + `-` arg (`echo "prompt" | codex exec -i img.png -`); positional prompt is silently dropped when stdin is detached.
- Pre-existing failures on main @ e2de7a3 (fail under BOTH Node 22.13 and 25; broke between dual-backend sweep and merge): apps/app/convex/agentSandboxIntegration.test.ts ("teaches the model when to use shell" — AGENT_SRC prompt strings), src/__tests__/agentApprovalResume.test.tsx ("returns explicit scoped approval decisions"), src/__tests__/searchWriteAudit.test.ts ("no atom-inserting convex file outside the known set"), src/__tests__/uploadFiles.test.tsx ("exposes an upload button in the file sidebar area"). 4 tests / 1618 passed. NOT fixed in Phase 0 — these are main's bugs; several die with Convex in Phase 13 anyway.

## Phase Logs

### Phase 0: Baseline, Tooling, And Old-Plan Inventory

- Status: in progress
- Execution map: env preflight (done: services healthy, node/codex/display recorded) → execution log (this file) → baseline script Node-pinned → baseline background run → inventory doc from recon digests → commit → codex review (high tier, background)
- Resume notes: baseline launching; inventory doc next; commit after baseline result recorded.
- Files changed: AGENTS.md (product philosophy: three legs, git-for-everyday-people, fast-is-a-feature, less-code; pivot note), plan (all pre-execution amendments), package.json (+check:desktop-local-first-baseline), scripts/check-desktop-local-first-baseline.mjs (new, Node-pinned), this log (new), inventory doc (new), team audit doc (committed as-is)
- Code deleted or consolidated: none (docs/tooling phase)
- Net LOC delta (`git diff --shortstat`): recorded at commit
- Old paths retained and why: all — inventory classifies, later phases delete
- Dependencies added (name, size, justification): none
- Decisions made (D-NN ids): D-01..D-08 (pre-execution, recorded above)
- Tests added: none (baseline phase)
- Commands run: docker compose ps (healthy); node path checks; component path verification; `pnpm check:desktop-local-first-baseline` (Node-pinned, background) — @dohc/web typecheck PASS, web tests 1618/1623 PASS (4 pre-existing, recorded in Gotchas); continue-on-error sweep of remaining suites — workspace-contracts 10/10, workspace-postgres 14/14, workspace-fs 8/8, workspace-api 3/3, app-tester 25/25, sqlite-worker 11/11, agent-sandbox 3/3, check:debt PASS (after rewording two self-tripping doc lines), web typecheck PASS
- Failing tests fixed: n/a — 4 web failures are pre-existing on main @ e2de7a3, recorded not fixed (several die with Convex in Phase 13)
- Electron E2E/manual smoke: n/a (no desktop app yet)
- UI/UX screenshot/design review: n/a
- Performance measurements: n/a
- Security/collaboration regressions: n/a
- Reviewer/subagent findings: recon digests above; 4-lens plan panel + Codex-utilization panel + 2 team audits all folded into plan pre-execution
- Codex third-party review findings (full: docs/superpowers/reviews/codex/phase-00.md): (1) baseline script fail-fasts on known web failures, can't reproduce recorded baseline at later gates — FIXED @ phase0(fix) commit (continue-on-error + summary + known-failure allowance that dies in Phase 13); (2) baseline omits @dohc/hocuspocus and @dohc/workspace-convex-compat suites — FIXED (both added); (3) pinned-Node path silently falls back to caller PATH on other machines — FIXED (existsSync check, DOHC_TEST_NODE_BIN override, hard error). Invocation gotcha discovered: `--commit` cannot combine with custom prompt (both codex versions) — plan updated with working pattern.
- Relevant findings fixed: all 3 codex P2s fixed in follow-up commit; plan-level findings fixed pre-execution
- Deferred findings with reason: none
- Remaining risk: baseline may surface pre-existing failures beyond the known Node issue — will be recorded verbatim, not fixed here
- Next phase: 1

### Phase 1: Local-First Workspace Core Contract

- Status: in progress (GREEN reached; verifiers running; commit pending)
- Execution map: tests-first for workspaceMode/paths/changeSet (written during Phase 0 review window) → pnpm install → RED recorded (3 files fail on missing modules) → implement 6 src modules → GREEN 28/28 + typecheck → verifier fan-out (test-quality worktree + claimed-vs-actual) → log → commit → codex review (high tier)
- Resume notes: if interrupted post-GREEN: verifiers wf_2b9debfd-c61; commit phase1 after pass.
- Files changed: packages/workspace-core/* (package.json, tsconfig.json, src: workspaceMode, metadata, paths, changeSet, conflicts, index + 3 test files), pnpm-lock.yaml (+12 lines, importer entry only)
- Code deleted or consolidated: none new; overlap with workspace-contracts recorded below
- Net LOC delta (`git diff --shortstat`): ~395 lines src+tests in new package; lockfile +12
- Old paths retained and why: workspace-contracts `WorkspacePath` (zod) + `composeRenamedPath` overlap workspace-core path validation — retained, live consumers in old API surface; consolidation owner = workspace-core per Phase 17 table (single path-validation owner). workspace-contracts domain types (AtomKind etc.) remain the old API's contract; workspace-core owns the NEW local-first model (modes/manifest/change sets) — no duplication between them today.
- Dependencies added (name, size, justification): none runtime; devDeps typescript/vitest/@types/node only (workspace conventions)
- Decisions made (D-NN ids): D-09 | workspace-core has zero runtime deps (no zod) — pure TS contract package; validation stays structural | smallest implementation; zod arrives only when IPC schemas need it (desktop-bridge) | phase 1
- Tests added: 31 (modes 4, paths 19, changeSet/conflicts 8) — covers all plan-required assertions incl. per-workspace-not-per-file mode, encoded/double-encoded/backslash traversal, reserved .dohc, .apps/.sqlite classification, 5 boundary crossings, marker-free conflict summaries
- Commands run: pnpm install (3.7s, links new package); workspace-core test (RED: 3 files fail missing modules → GREEN: 28/28); typecheck PASS — all under pinned Node 22.13
- Failing tests fixed: RED→GREEN by implementation only; no test weakened
- Electron E2E/manual smoke: n/a (pure contract package)
- UI/UX screenshot/design review: n/a
- Performance measurements: n/a (no measurable surface; tests run in 305ms)
- Security/collaboration regressions: path traversal coverage incl. %2e and backslash variants; boundary-crossing review gate asserted per crossing
- Reviewer/subagent findings: verifier workflow wf_2b9debfd-c61 — test-quality PASS (worktree revert: 0 tests pass without implementation; reason-specific assertions confirmed); claimed-vs-actual PASS (all plan files present, all claims re-verified independently, cheat scan clean). Finding 1: double-encoded traversal (%252e) passed single-pass decoding — FIXED pre-commit (decode-until-stable + 3 new traversal cases, 31/31). Finding 2 (note): repo .nvmrc pins 24.14.0 (not installed); our freeze is the documented 22.13.0 PATH prefix — consistent with engines, recorded.
- Codex third-party review findings: pending post-commit
- Relevant findings fixed: verifier finding 1 fixed pre-commit
- Deferred findings with reason: none
- Remaining risk: API shapes may evolve when Phase 4 (registry) and Phase 5 (history) consume them — acceptable, contract-first by design
- Next phase: 2

exec
/bin/bash -lc "sed -n '1,260p' docs/superpowers/reviews/codex/phase-01.md 2>/dev/null || true" in /home/ice/dev/dohc
 succeeded in 0ms:
OpenAI Codex v0.130.0
--------
workdir: /home/ice/dev/dohc
model: gpt-5.5
provider: openai
approval: never
sandbox: read-only
reasoning effort: high
reasoning summaries: none
session id: 019eb09e-49a3-71f0-b923-ca801a546c81
--------
user
commit 67d692f
warning: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
exec
/bin/bash -lc 'git status --short && git rev-parse --show-toplevel && git show --stat --oneline --decorate --no-renames 67d692f' in /home/ice/dev/dohc
 succeeded in 0ms:
?? docs/superpowers/reviews/codex/phase-01.md
/home/ice/dev/dohc
67d692f (HEAD -> claude/desktop-local-first-cloud-sync) phase1: Add local-first workspace core contract
 ...desktop-local-first-cloud-sync.execution-log.md | 25 ++++++
 packages/workspace-core/package.json               | 17 ++++
 packages/workspace-core/src/changeSet.test.ts      | 84 ++++++++++++++++++
 packages/workspace-core/src/changeSet.ts           | 57 +++++++++++++
 packages/workspace-core/src/conflicts.ts           | 13 +++
 packages/workspace-core/src/index.ts               |  5 ++
 packages/workspace-core/src/metadata.ts            | 36 ++++++++
 packages/workspace-core/src/paths.test.ts          | 99 ++++++++++++++++++++++
 packages/workspace-core/src/paths.ts               | 66 +++++++++++++++
 packages/workspace-core/src/workspaceMode.test.ts  | 32 +++++++
 packages/workspace-core/src/workspaceMode.ts       | 16 ++++
 packages/workspace-core/tsconfig.json              |  4 +
 pnpm-lock.yaml                                     | 12 +++
 13 files changed, 466 insertions(+)

exec
/bin/bash -lc 'git show --no-ext-diff --unified=80 --no-renames 67d692f -- packages/workspace-core/src packages/workspace-core/package.json packages/workspace-core/tsconfig.json pnpm-lock.yaml' in /home/ice/dev/dohc
 succeeded in 0ms:
commit 67d692f36d360eec6d69e58bd4a21f097ffa0d41
Author: Ice de Vera <iestyndevera@gmail.com>
Date:   Wed Jun 10 16:20:09 2026 +0800

    phase1: Add local-first workspace core contract
    
    Workspace modes (personal=local-first, shared=cloud-first-local-copy),
    manifest/file-record metadata, path validation (traversal incl. double-
    encoded variants, reserved .dohc, app/database classification), change
    sets with liberal review policy (5 boundary crossings), human-readable
    conflict summaries. 31 tests, RED recorded before implementation,
    verifier fan-out passed (test-quality worktree + claimed-vs-actual).
    
    Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

diff --git a/packages/workspace-core/package.json b/packages/workspace-core/package.json
new file mode 100644
index 0000000..dcb85c5
--- /dev/null
+++ b/packages/workspace-core/package.json
@@ -0,0 +1,17 @@
+{
+  "name": "@dohc/workspace-core",
+  "private": true,
+  "type": "module",
+  "exports": {
+    ".": "./src/index.ts"
+  },
+  "scripts": {
+    "test": "vitest run",
+    "typecheck": "tsc --noEmit"
+  },
+  "devDependencies": {
+    "@types/node": "^22.19.19",
+    "typescript": "^5.9.3",
+    "vitest": "^2.1.9"
+  }
+}
diff --git a/packages/workspace-core/src/changeSet.test.ts b/packages/workspace-core/src/changeSet.test.ts
new file mode 100644
index 0000000..6e6834d
--- /dev/null
+++ b/packages/workspace-core/src/changeSet.test.ts
@@ -0,0 +1,84 @@
+import { describe, expect, it } from "vitest";
+import {
+  addBoundaryCrossing,
+  addFileChanges,
+  createChangeSet,
+  requiresReview,
+  type BoundaryCrossing,
+} from "./changeSet";
+import { describeConflict } from "./conflicts";
+
+const agentAuthor = {
+  kind: "agent" as const,
+  agentId: "codex-local",
+  onBehalfOf: "user-1",
+};
+
+describe("change set grouping", () => {
+  it("groups one agent run editing many files into a single change set", () => {
+    const set = createChangeSet({
+      kind: "agent-run",
+      author: agentAuthor,
+      summary: "Imported transactions and built ledger app",
+    });
+    const files = Array.from({ length: 18 }, (_, i) => ({
+      path: `finance/.apps/ledger/src/file-${i}.tsx`,
+      operation: "write" as const,
+    }));
+    const grouped = addFileChanges(set, files);
+    expect(grouped.files).toHaveLength(18);
+    expect(grouped.kind).toBe("agent-run");
+    expect(grouped.author).toEqual(agentAuthor);
+  });
+});
+
+describe("review requirements", () => {
+  it("does not require approval for normal allowed edits", () => {
+    const set = addFileChanges(
+      createChangeSet({
+        kind: "user-edit",
+        author: { kind: "user", userId: "user-1" },
+        summary: "Edited notes",
+      }),
+      [{ path: "notes/today.md", operation: "write" }],
+    );
+    expect(requiresReview(set)).toBe(false);
+  });
+
+  const crossings: BoundaryCrossing[] = [
+    "public-share",
+    "permission-change",
+    "bulk-delete",
+    "app-trust",
+    "private-to-shared",
+  ];
+
+  for (const crossing of crossings) {
+    it(`requires review for boundary crossing: ${crossing}`, () => {
+      const set = addBoundaryCrossing(
+        createChangeSet({
+          kind: "agent-run",
+          author: agentAuthor,
+          summary: "Crossed a boundary",
+        }),
+        crossing,
+      );
+      expect(requiresReview(set)).toBe(true);
+      expect(set.boundaryCrossings).toContain(crossing);
+    });
+  }
+});
+
+describe("conflict summaries", () => {
+  it("produces a human-readable summary without Git conflict markers", () => {
+    const summary = describeConflict({
+      path: "notes/plan.md",
+      localDescription: "you reworded the intro",
+      remoteDescription: "Maya added a budget section",
+    });
+    expect(summary).toContain("notes/plan.md");
+    expect(summary).toContain("you reworded the intro");
+    expect(summary).toContain("Maya added a budget section");
+    expect(summary).not.toMatch(/<{7}|>{7}|={7}/);
+  });
+});
diff --git a/packages/workspace-core/src/changeSet.ts b/packages/workspace-core/src/changeSet.ts
new file mode 100644
index 0000000..5773eaf
--- /dev/null
+++ b/packages/workspace-core/src/changeSet.ts
@@ -0,0 +1,57 @@
+export type ChangeSetKind =
+  | "user-edit"
+  | "agent-run"
+  | "import"
+  | "sync"
+  | "app-build";
+
+export type BoundaryCrossing =
+  | "public-share"
+  | "external-export"
+  | "permission-change"
+  | "bulk-delete"
+  | "app-trust"
+  | "private-to-shared"
+  | "unmergeable-overwrite";
+
+export type ChangeAuthor =
+  | { kind: "user"; userId: string }
+  | { kind: "agent"; agentId: string; onBehalfOf: string };
+
+export interface FileChange {
+  path: string;
+  operation: "write" | "delete" | "rename";
+}
+
+export interface ChangeSet {
+  kind: ChangeSetKind;
+  author: ChangeAuthor;
+  summary: string;
+  files: FileChange[];
+  boundaryCrossings: BoundaryCrossing[];
+}
+
+export function createChangeSet(input: {
+  kind: ChangeSetKind;
+  author: ChangeAuthor;
+  summary: string;
+}): ChangeSet {
+  return { ...input, files: [], boundaryCrossings: [] };
+}
+
+export function addFileChanges(set: ChangeSet, files: FileChange[]): ChangeSet {
+  return { ...set, files: [...set.files, ...files] };
+}
+
+export function addBoundaryCrossing(
+  set: ChangeSet,
+  crossing: BoundaryCrossing,
+): ChangeSet {
+  return { ...set, boundaryCrossings: [...set.boundaryCrossings, crossing] };
+}
+
+// Liberal by default: ordinary edits sync freely; only genuine boundary
+// crossings need a human to look.
+export function requiresReview(set: ChangeSet): boolean {
+  return set.boundaryCrossings.length > 0;
+}
diff --git a/packages/workspace-core/src/conflicts.ts b/packages/workspace-core/src/conflicts.ts
new file mode 100644
index 0000000..7c24e46
--- /dev/null
+++ b/packages/workspace-core/src/conflicts.ts
@@ -0,0 +1,13 @@
+export interface ConflictInput {
+  path: string;
+  localDescription: string;
+  remoteDescription: string;
+}
+
+// Conflicts read like a sentence, never like Git markers.
+export function describeConflict(input: ConflictInput): string {
+  return (
+    `Both sides changed ${input.path}: ${input.localDescription}, ` +
+    `while ${input.remoteDescription}. Both versions are kept until you choose.`
+  );
+}
diff --git a/packages/workspace-core/src/index.ts b/packages/workspace-core/src/index.ts
new file mode 100644
index 0000000..7d6db61
--- /dev/null
+++ b/packages/workspace-core/src/index.ts
@@ -0,0 +1,5 @@
+export * from "./workspaceMode";
+export * from "./metadata";
+export * from "./paths";
+export * from "./changeSet";
+export * from "./conflicts";
diff --git a/packages/workspace-core/src/metadata.ts b/packages/workspace-core/src/metadata.ts

exec
/bin/bash -lc "node - <<'NODE'
const path=require('node:path');
for (const p of ['C:/Windows/system32','C:/Users/x/file.md','C:\\\\Windows\\\\system32']) {
  console.log(p, path.win32.isAbsolute(p), path.win32.resolve('C:/workspace/root', p), path.win32.join('C:/workspace/root', p));
}
NODE" in /home/ice/dev/dohc
 succeeded in 106ms:
C:/Windows/system32 true C:\Windows\system32 C:\workspace\root\C:\Windows\system32
C:/Users/x/file.md true C:\Users\x\file.md C:\workspace\root\C:\Users\x\file.md
C:\Windows\system32 true C:\Windows\system32 C:\workspace\root\C:\Windows\system32

codex
The new core contract mostly matches the phase goals, but its path handling has security/data-integrity holes on common case-insensitive filesystems and Windows drive paths, and it blocks Windows attached workspace folders. These issues should be fixed before downstream desktop/filesystem code relies on this package.

Full review comments:

- [P1] Treat case-insensitive .dohc variants as reserved — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:16-17
  On default macOS/Windows workspaces, the filesystem is case-insensitive, so `.DOHC/manifest.json` aliases the reserved `.dohc/manifest.json`. Because this only compares the lowercase literal `.dohc`, `validateUserWritePath(".DOHC/manifest.json")` returns ok and later filesystem writes can overwrite dohc metadata the reserved-space guard is meant to protect.

- [P1] Reject Windows drive-qualified write paths — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:25-26
  When this validator runs on Windows, inputs such as `C:\Users\ice\secret.md` are not caught by the `/` absolute check; after backslash normalization they are returned as `C:/Users/ice/secret.md`. A caller that resolves the accepted path against the workspace root with `path.win32.resolve` will treat it as an absolute path and write outside the workspace, so drive-qualified paths need to be rejected before returning `ok`.

- [P2] Use platform-aware attached-folder validation — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:7-9
  For Windows desktop users, a real absolute folder like `C:\Users\ice\dohc` fails this check because it does not start with `/`, so they cannot attach/open arbitrary workspace folders despite the contract allowing attached absolute folders. Use platform-aware absolute-path detection, or explicitly accept both POSIX and Windows absolute forms, before this is wired into the desktop shell.
The new core contract mostly matches the phase goals, but its path handling has security/data-integrity holes on common case-insensitive filesystems and Windows drive paths, and it blocks Windows attached workspace folders. These issues should be fixed before downstream desktop/filesystem code relies on this package.

Full review comments:

- [P1] Treat case-insensitive .dohc variants as reserved — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:16-17
  On default macOS/Windows workspaces, the filesystem is case-insensitive, so `.DOHC/manifest.json` aliases the reserved `.dohc/manifest.json`. Because this only compares the lowercase literal `.dohc`, `validateUserWritePath(".DOHC/manifest.json")` returns ok and later filesystem writes can overwrite dohc metadata the reserved-space guard is meant to protect.

- [P1] Reject Windows drive-qualified write paths — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:25-26
  When this validator runs on Windows, inputs such as `C:\Users\ice\secret.md` are not caught by the `/` absolute check; after backslash normalization they are returned as `C:/Users/ice/secret.md`. A caller that resolves the accepted path against the workspace root with `path.win32.resolve` will treat it as an absolute path and write outside the workspace, so drive-qualified paths need to be rejected before returning `ok`.

- [P2] Use platform-aware attached-folder validation — /home/ice/dev/dohc/packages/workspace-core/src/paths.ts:7-9
  For Windows desktop users, a real absolute folder like `C:\Users\ice\dohc` fails this check because it does not start with `/`, so they cannot attach/open arbitrary workspace folders despite the contract allowing attached absolute folders. Use platform-aware absolute-path detection, or explicitly accept both POSIX and Windows absolute forms, before this is wired into the desktop shell.
