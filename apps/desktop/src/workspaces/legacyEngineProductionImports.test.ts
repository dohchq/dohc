import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// R16 ratchet. The legacy TypeScript engine `@dohc/workspace-engine` is being
// deleted in favour of the Rust daemon. Deleting it is blocked on work tracked
// on #391, but NOTHING should be allowed to add a new production dependency on
// it while that work is in flight — every new importer is another thing to
// unpick later.
//
// So this asserts SET EQUALITY against the list below, not "no more than".
// Adding an importer fails, and so does removing one without editing the list:
// the shrinking is the point, and it should be a deliberate, reviewed edit that
// records the win rather than a number that quietly drifts.
//
// Type-only imports are fine — they carry no runtime dependency and vanish at
// build time — so they are not listed and not counted.

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const LEGACY_PACKAGE = "@dohc/workspace-engine";

// Production files with a RUNTIME import of the legacy engine. Shrink this list
// as the migration proceeds; never grow it.
//
// Both entries are blocked on the same thing (#391): `workspaceEngineCapture`
// imports the two store factories used by the daemon-unavailable fallback, and
// `ydocEngineProviderSession` is the legacy provider session that fallback
// selects. Its Rust replacement already exists.
//
// Seven other production files name this package but import only TYPES, so they
// are absent by design, not by omission — see the parser tests below.
const ALLOWED = [
  "apps/desktop/src/collab/ydocEngineProviderSession.ts",
  "apps/desktop/src/workspaces/workspaceEngineCapture.ts",
] as const;

const SCAN_ROOTS = ["apps", "packages", "services"];

// Not production: the legacy package itself, test files, Playwright specs, and
// build/QA tooling.
function isProductionSource(posixPath: string): boolean {
  if (posixPath.startsWith("packages/workspace-engine/")) return false;
  if (/\.(test|spec)\.tsx?$/.test(posixPath)) return false;
  if (posixPath.includes("/e2e/")) return false;
  if (posixPath.includes("/scripts/")) return false;
  if (posixPath.includes("/testing/")) return false;
  return /\.tsx?$/.test(posixPath);
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  "target",
  ".git",
]);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, out);
    else out.push(full);
  }
}

// Matches `import ... from "@dohc/workspace-engine"` / subpaths, plus bare
// side-effect imports and `export ... from`, capturing the clause so a
// type-only import can be told apart from a runtime one.
//
// The clause is `[^;"']*?` rather than `[\s\S]*?` on purpose. A lazy
// any-character clause starts matching at the FIRST import in the file and
// spans every statement up to this module's `from`, so a file whose first
// import happens to be `import type { … } from "@dohc/workspace-core"` yields a
// clause beginning with `type` — and the type-only check below then waves
// through a genuine runtime import. That false negative is what this guard
// exists to prevent, so: a real import clause contains no quote and no
// semicolon, which pins the match to a single statement.
const IMPORT_RE = new RegExp(
  String.raw`(?:^|\n)\s*(?:import|export)\b([^;"']*?)\bfrom\s*["']` +
    LEGACY_PACKAGE.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&") +
    String.raw`(?:/[^"']*)?["']`,
  "g",
);
const BARE_IMPORT_RE = new RegExp(
  String.raw`(?:^|\n)\s*import\s*["']` +
    LEGACY_PACKAGE.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&") +
    String.raw`(?:/[^"']*)?["']`,
  "g",
);
// `await import(...)`, `require(...)` and `import x = require(...)`. All three
// load at runtime and none of them can be type-only, so no clause analysis is
// needed — the call form alone is the answer.
//
// Nothing imports the legacy engine this way today. It is covered because the
// codebase does use dynamic import to keep heavy modules off the launch path
// (`workspaceDatabase.ts:333` does exactly that for `@dohc/sqlite-worker`), so
// it is a form a future change would plausibly reach for — and a guard that a
// one-line change can walk around is not a guard.
const DYNAMIC_RE = new RegExp(
  String.raw`\b(?:import|require)\s*\(\s*["']` +
    LEGACY_PACKAGE.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&") +
    String.raw`(?:/[^"']*)?["']\s*\)`,
  "g",
);

function hasRuntimeLegacyImport(source: string): boolean {
  if (BARE_IMPORT_RE.test(source)) {
    BARE_IMPORT_RE.lastIndex = 0;
    return true;
  }
  BARE_IMPORT_RE.lastIndex = 0;
  if (DYNAMIC_RE.test(source)) {
    DYNAMIC_RE.lastIndex = 0;
    return true;
  }
  DYNAMIC_RE.lastIndex = 0;
  IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const clause = (match[1] ?? "").trim();
    // `import type { X }` — erased entirely.
    if (/^type\b/.test(clause)) continue;
    // `import { type A, type B }` — every named binding is type-only, so this
    // is erased too. A single value binding among them makes it runtime.
    const named = clause.match(/^\{([\s\S]*)\}$/);
    if (named) {
      const specifiers = named[1]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (specifiers.length > 0 && specifiers.every((s) => /^type\s/.test(s)))
        continue;
    }
    return true;
  }
  return false;
}

describe("legacy engine production imports (R16 ratchet)", () => {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), files);
  const importers = files
    .map((f) => relative(REPO_ROOT, f).split(sep).join("/"))
    .filter(isProductionSource)
    .filter((p) =>
      hasRuntimeLegacyImport(readFileSync(join(REPO_ROOT, p), "utf8")),
    )
    .sort();

  it("actually reached every scan root — a scan that matched nothing would pass vacuously", () => {
    // Without this, a broken REPO_ROOT or an over-eager skip list turns the
    // assertion below into [] === [] the moment the allowlist empties.
    //
    // One sentinel per scan root rather than a total file count. A count is a
    // proxy for "did the walk work" that also rejects legitimate deletion once
    // the repo shrinks past whatever number you picked, and there is no measured
    // healthy range to pick from. These three prove each root was walked, and
    // they fail loudly if one is ever renamed — which is the correct outcome,
    // since a renamed sentinel means this guard is no longer checking that root.
    const scanned = new Set(
      files.map((f) => relative(REPO_ROOT, f).split(sep).join("/")),
    );
    for (const sentinel of [
      "apps/desktop/src/main.ts",
      "packages/workspace-contracts/src/engine.ts",
      "services/sync-relay/src/errorCodes.ts",
    ]) {
      expect(scanned, `scan root for ${sentinel} was not walked`).toContain(
        sentinel,
      );
    }
  });

  it("matches the allowlist exactly, so the count can only shrink deliberately", () => {
    expect(importers).toEqual([...ALLOWED].sort());
  });

  it("still detects a runtime import that hides among type-only specifiers", () => {
    // Guards the parser itself: the discrimination above is the whole test, and
    // a parser that called everything type-only would report zero importers.
    expect(
      hasRuntimeLegacyImport(`import type { A } from "${LEGACY_PACKAGE}";`),
    ).toBe(false);
    expect(
      hasRuntimeLegacyImport(
        `import { type A, type B } from "${LEGACY_PACKAGE}";`,
      ),
    ).toBe(false);
    expect(
      hasRuntimeLegacyImport(
        `import { type A, thing } from "${LEGACY_PACKAGE}";`,
      ),
    ).toBe(true);
    expect(
      hasRuntimeLegacyImport(`import { thing } from "${LEGACY_PACKAGE}";`),
    ).toBe(true);
    expect(hasRuntimeLegacyImport(`import "${LEGACY_PACKAGE}";`)).toBe(true);
    expect(
      hasRuntimeLegacyImport(
        `import { thing } from "${LEGACY_PACKAGE}/testing";`,
      ),
    ).toBe(true);
    expect(
      hasRuntimeLegacyImport(
        `import { thing } from "@dohc/workspace-engine-client";`,
      ),
    ).toBe(false);
  });

  it("does not let a preceding type-only import mask a real one", () => {
    // The bug this replaces: with a lazy any-character clause, the match began
    // at the FIRST import in the file and spanned every statement up to this
    // module's `from`, so the clause started with `type` and the whole runtime
    // import was waved through. workspaceEngineCapture.ts hit exactly this —
    // its first import is `import type { WatcherEvent } from
    // "@dohc/workspace-core"` — and the guard reported zero importers for it.
    const source = [
      `import type { WatcherEvent } from "@dohc/workspace-core";`,
      `import { validateThing } from "@dohc/workspace-core";`,
      `import {`,
      `  createVersionedTextStore,`,
      `  type VersionedTextStore,`,
      `} from "${LEGACY_PACKAGE}";`,
    ].join("\n");
    expect(hasRuntimeLegacyImport(source)).toBe(true);
  });

  it("detects runtime loads that are not static imports", () => {
    // A guard a one-line change can walk around is not a guard. None of these
    // forms can be type-only, so the call form alone settles it.
    expect(
      hasRuntimeLegacyImport(`const m = await import("${LEGACY_PACKAGE}");`),
    ).toBe(true);
    expect(
      hasRuntimeLegacyImport(`const m = require("${LEGACY_PACKAGE}");`),
    ).toBe(true);
    expect(
      hasRuntimeLegacyImport(`import m = require("${LEGACY_PACKAGE}");`),
    ).toBe(true);
    expect(
      hasRuntimeLegacyImport(
        `const { x } = await import("${LEGACY_PACKAGE}/testing");`,
      ),
    ).toBe(true);
    expect(
      hasRuntimeLegacyImport(`const m = await import( '${LEGACY_PACKAGE}' );`),
    ).toBe(true);
    // Must not fire on a different package that merely shares the prefix.
    expect(
      hasRuntimeLegacyImport(`await import("@dohc/workspace-engine-client");`),
    ).toBe(false);
  });
});
