#!/usr/bin/env node
// Architecture-debt gate for the desktop-first/Postgres architecture.
//
// Fails when shipping source re-grows the evolution debt this branch deleted:
// legacy-backend references, dual-backend switches, `.views` product
// language, broken module boundaries (renderer importing Node/Electron,
// desktop importing web code, preload bypassing the typed IPC contract), or
// NEW duplicates of helpers that have one owner (path validation and the
// extension -> media-type table live in packages/workspace-core).
//
// Every allowlist entry names a reason and a deletion condition; the audit
// doc (docs/superpowers/reviews/2026-06-10-desktop-local-first-tech-debt-audit.md)
// mirrors them.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/check-architecture-debt.mjs";
// Built so this file does not trip its own token scan.
const term = (...parts) => parts.join("");

const failures = [];

// --- shared walking ---------------------------------------------------------

const skippedDirectories = new Set([
  ".git",
  ".output",
  ".turbo",
  ".vercel",
  ".vinxi",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "release",
  "test-results",
]);
const binaryExtensions = new Set([
  ".avif", ".bmp", ".gif", ".icns", ".ico", ".jpeg", ".jpg", ".m4a", ".mp3",
  ".pdf", ".png", ".sqlite", ".db", ".webp", ".woff", ".woff2", ".zip",
]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skippedDirectories.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (!stat.isFile()) continue;
    const dot = name.lastIndexOf(".");
    if (dot !== -1 && binaryExtensions.has(name.slice(dot).toLowerCase())) continue;
    yield full;
  }
}

function rel(file) {
  return relative(root, file).replace(/\\/g, "/");
}

function readText(file) {
  const body = readFileSync(file);
  if (body.includes(0)) return null;
  return body.toString("utf8");
}

function listFiles(...dirs) {
  const out = [];
  for (const dir of dirs) {
    try {
      statSync(join(root, dir));
    } catch {
      continue;
    }
    for (const file of walk(join(root, dir))) out.push(file);
  }
  return out;
}

// --- rule 1: forbidden evolution language ------------------------------------

// Shipping scope: everything that runs or configures what runs.
const SHIPPING_DIRS = ["apps", "packages", "services", "scripts", "tests"];
const SHIPPING_ROOT_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "README.md",
  "AGENTS.md",
  ".coderabbit.yaml",
  "docker-compose.dev.yml",
  "docker-compose.self-host.yml",
  ".env.example",
  ".env.self-host.example",
];

const FORBIDDEN = [
  { label: term("conv", "ex backend reference"), regex: new RegExp(term("conv", "ex"), "i") },
  { label: term("workspace-conv", "ex-compat"), regex: new RegExp(term("workspace-conv", "ex-compat"), "i") },
  { label: term("DOHC_BACK", "END env switch"), regex: new RegExp(term("DOHC_BACK", "END")) },
  { label: term("dual-back", "end switch language"), regex: new RegExp(term("dual[-_ ]back", "end"), "i") },
  { label: term(".vie", "ws product language"), regex: new RegExp(term("\\.vie", "ws(?:/|\\b)")) },
  { label: term("@dohc/vie", "w product language"), regex: new RegExp(term("@dohc/vie", "w\\b")) },
  { label: "legacy onboarding dashboard language", regex: /onboarding[-_ ]dashboard/i },
  { label: "markdown-only fake dashboard language", regex: /(?:fake|markdown[-_ ]only)[-_ ]dashboard/i },
];

// reason + deleteWhen are mandatory; scope is the exact set of rule labels
// the file may contain.
const FORBIDDEN_ALLOWLIST = [
  {
    file: "services/hocuspocus/src/postgres-acl.test.ts",
    labels: [term("conv", "ex backend reference")],
    reason: "Anti-regression assertion: the test FAILS if legacy-backend code returns to the ACL.",
    deleteWhen: "Delete if the postgres-acl module is replaced wholesale.",
  },
  {
    file: term("apps/web/src/routes/_app.shared.$shareId.tsx"),
    labels: [term("conv", "ex backend reference")],
    reason: "Honest comment: pre-pivot share-row links 404 because that store was deleted, not migrated.",
    deleteWhen: "Delete when the /shared/$shareId alias route is removed.",
  },
  {
    file: "scripts/check-tech-debt.mjs",
    labels: [term("dual-back", "end switch language")],
    reason: "References the HISTORICAL plan document filename in its own allowlist entries.",
    deleteWhen: "Delete when those plan-doc allowlist entries are removed from check-tech-debt.mjs.",
  },
  {
    file: "services/app-tester/src/staticCheck.ts",
    labels: [term(".vie", "ws product language"), term("@dohc/vie", "w product language")],
    reason: "The app trust check REJECTS legacy app code; it must name the patterns it bans.",
    deleteWhen: "Delete when the static trust check drops its legacy-pattern rejection rule.",
  },
  {
    file: "services/app-tester/src/staticCheck.test.ts",
    labels: [term(".vie", "ws product language"), term("@dohc/vie", "w product language")],
    reason: "Fixtures proving the trust check rejects legacy app code.",
    deleteWhen: "Delete together with the staticCheck legacy-pattern rule.",
  },
  {
    file: "apps/desktop/src/workspaces/appPackage.test.ts",
    labels: [term("@dohc/vie", "w product language")],
    reason: "Fixture proving AppTester fails a legacy-SDK app end-to-end through the desktop pipeline.",
    deleteWhen: "Delete together with the staticCheck legacy-pattern rule.",
  },
  {
    file: "apps/desktop/e2e/appPackage.spec.ts",
    labels: [term("@dohc/vie", "w product language")],
    reason: "E2E fixture proving the desktop shows a legacy-SDK app as failed/untrusted.",
    deleteWhen: "Delete together with the staticCheck legacy-pattern rule.",
  },
];

// --- rule 2: docs may reference the old world only as marked history ----------

// EXACT paths only. These are plans, reviews, execution logs, and documents
// carrying an explicit Historical banner. Adding old-architecture language to
// any OTHER doc fails this gate.
const HISTORICAL_DOCS = new Set([
  "docs/architecture/backend-modes.md",
  "docs/development/local-dev.md",
  "docs/development/multiplayer-and-h-followups-plan.md",
  "docs/development/multiplayer-m1-step3-architecture.md",
  "docs/development/org-plan.md",
  "docs/development/phase-b-survey.md",
  "docs/development/search-plan.md",
  "docs/development/testing.md",
  "docs/development/tiptap-hocuspocus-evaluation.md",
  "docs/development/transport-spike-result.md",
  "docs/development/v2-corpus-export.md",
  "docs/development/v2-current-editor-behavior.md",
  "docs/development/v2-hocuspocus-persistence.md",
  "docs/development/v2-phase-0-baseline.md",
  "docs/development/v2-phase-0-inventory.md",
  "docs/development/v2-phase-plans/phase-0.md",
  term("docs/development/v2-phase-plans/phase-1.3-conv", "ex-acl-bridge.md"),
  "docs/development/v2-phase-plans/phase-1.3.md",
  "docs/development/v2-phase-plans/phase-1.4.md",
  "docs/development/v2-phase-plans/phase-1.6.md",
  "docs/development/v2-phase-plans/phase-1.7.md",
  "docs/development/v2-phase-plans/phase-1.8.md",
  "docs/development/v2-phase-plans/phase-1.9.md",
  "docs/development/v2-pivot-plan.md",
  "docs/product/spec.md",
  "docs/qa/playwright-checklist.md",
  "docs/superpowers/plans/2026-05-29-workspace-address-routing.md",
  "docs/superpowers/plans/2026-05-30-agent-runs-mvp.md",
  "docs/superpowers/plans/2026-06-01-agent-multi-provider.md",
  "docs/superpowers/plans/2026-06-01-folder-views-runtime.md",
  "docs/superpowers/plans/2026-06-03-first-useful-turn-agent-prompt.md",
  "docs/superpowers/plans/2026-06-06-dohc-apps-sdk-sqlite-and-agent-testing.execution-log.md",
  "docs/superpowers/plans/2026-06-06-dohc-apps-sdk-sqlite-and-agent-testing.md",
  term("docs/superpowers/plans/2026-06-09-dohc-dual-back", "end-filesystem-agent-runtime.execution-log.md"),
  term("docs/superpowers/plans/2026-06-09-dohc-dual-back", "end-filesystem-agent-runtime.md"),
  "docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.execution-log.md",
  "docs/superpowers/plans/2026-06-10-dohc-desktop-local-first-cloud-sync.md",
  "docs/superpowers/reviews/2026-06-06-apps-sdk-sqlite-agent-testing-review.md",
  term("docs/superpowers/reviews/2026-06-09-dual-back", "end-readiness-review.md"),
  term("docs/superpowers/reviews/2026-06-09-dual-back", "end-tech-debt-audit.md"),
  term("docs/superpowers/reviews/2026-06-10-conv", "ex-deletion-review.md"),
  "docs/superpowers/reviews/2026-06-10-desktop-component-reuse-map.md",
  "docs/superpowers/reviews/2026-06-10-desktop-local-first-cloud-sync-plan-audit.md",
  "docs/superpowers/reviews/2026-06-10-desktop-local-first-tech-debt-audit.md",
  "docs/superpowers/reviews/2026-06-10-old-plan-port-delete-inventory.md",
  "docs/superpowers/reviews/codex/checkpoint-phase-04.md",
  "docs/superpowers/reviews/codex/phase-00.md",
  "docs/superpowers/reviews/codex/phase-01.md",
  "docs/superpowers/reviews/codex/phase-02.md",
  "docs/superpowers/reviews/codex/phase-03.md",
  "docs/superpowers/reviews/codex/phase-04-fix.md",
  "docs/superpowers/reviews/codex/phase-04.md",
  "docs/superpowers/reviews/codex/phase-05-fix.md",
  "docs/superpowers/reviews/codex/phase-05.md",
  "docs/superpowers/reviews/codex/phase-06.md",
  "docs/superpowers/reviews/codex/phase-07.md",
  "docs/superpowers/reviews/codex/phase-10.md",
  "docs/superpowers/specs/2026-05-29-workspace-address-routing-design.md",
  "docs/superpowers/specs/2026-06-03-first-useful-turn-agent-prompt-design.md",
]);

function scanForbidden() {
  const files = [
    ...listFiles(...SHIPPING_DIRS),
    ...SHIPPING_ROOT_FILES.map((f) => join(root, f)),
  ];
  for (const file of files) {
    const r = rel(file);
    if (r === SELF) continue;
    if (r === "pnpm-lock.yaml") continue;
    let body;
    try {
      body = readText(file);
    } catch {
      continue;
    }
    if (body === null) {
      // A NUL byte makes git treat source as binary (unreviewable diffs) and
      // would silently exempt the file from every text rule in this gate.
      if (/\.(ts|tsx|mjs|cjs|js)$/.test(r)) {
        failures.push(
          `${r} contains a NUL byte — source must stay text (use the \\u0000 escape); binary-masked source is invisible to this gate and to git diff`,
        );
      }
      continue;
    }
    const lines = body.split(/\r?\n/);
    for (const rule of FORBIDDEN) {
      lines.forEach((line, i) => {
        if (!rule.regex.test(line)) return;
        const allowed = FORBIDDEN_ALLOWLIST.some(
          (entry) => entry.file === r && entry.labels.includes(rule.label),
        );
        if (!allowed) {
          failures.push(`${r}:${i + 1} [${rule.label}] ${line.trim().slice(0, 120)}`);
        }
      });
    }
  }

  for (const file of listFiles("docs")) {
    const r = rel(file);
    const body = readText(file);
    if (body === null) continue;
    for (const rule of FORBIDDEN) {
      if (rule.regex.test(body) && !HISTORICAL_DOCS.has(r)) {
        failures.push(
          `${r} [${rule.label}] — doc references the old architecture but is not in the exact-path historical allowlist`,
        );
        break;
      }
    }
  }
}

// --- rule 3: module boundaries ------------------------------------------------

const IMPORT_RE = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;

function importsOf(body) {
  const specs = [];
  for (const match of body.matchAll(IMPORT_RE)) specs.push(match[1]);
  return specs;
}

function scanBoundaries() {
  // 3a. Desktop must not reach into web code except via shared packages.
  for (const file of listFiles("apps/desktop/src", "apps/desktop/e2e")) {
    const body = readText(file);
    if (body === null) continue;
    for (const spec of importsOf(body)) {
      if (spec === "@dohc/web" || spec.includes("apps/web/")) {
        failures.push(`${rel(file)} imports web-only code (${spec}); share via packages/* instead`);
      }
    }
  }

  // 3b. The sandboxed renderer gets NO Node or Electron access — the typed
  // preload bridge is the only seam. Applies to tests too (they currently
  // need none, and a test that imports Node from renderer code usually means
  // renderer code is about to).
  const NODE_BUILTINS = new Set([
    "child_process", "crypto", "fs", "http", "https", "net", "os", "path", "process", "url",
  ]);
  for (const file of listFiles("apps/desktop/src/renderer")) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const body = readText(file);
    if (body === null) continue;
    for (const spec of importsOf(body)) {
      if (spec.startsWith("node:") || spec === "electron" || spec.startsWith("electron/") || NODE_BUILTINS.has(spec)) {
        failures.push(`${rel(file)} imports ${spec} — the renderer must stay sandboxed (bridge/preload is the only seam)`);
      }
    }
  }

  // 3c. Preload exposes ONLY the typed contract: every ipcRenderer call uses
  // a CHANNELS.* constant (no dynamic/passthrough channels), and only the
  // known bridge globals are exposed.
  const preload = readText(join(root, "apps/desktop/src/preload.ts"));
  if (preload === null) {
    failures.push("apps/desktop/src/preload.ts missing or unreadable");
  } else {
    for (const match of preload.matchAll(/ipcRenderer\.(invoke|send|on|removeListener)\(\s*([^),\s]+)/g)) {
      if (!match[2].startsWith("CHANNELS.")) {
        failures.push(
          `apps/desktop/src/preload.ts: ipcRenderer.${match[1]}(${match[2]} …) — channels must be CHANNELS.* constants (no passthrough)`,
        );
      }
    }
    const allowedGlobals = new Set(["dohcDesktop", "dohcDesktopInternal", "dohcDesktopTest"]);
    for (const match of preload.matchAll(/exposeInMainWorld\(\s*["']([^"']+)["']/g)) {
      if (!allowedGlobals.has(match[1])) {
        failures.push(`apps/desktop/src/preload.ts exposes unexpected global "${match[1]}"`);
      }
    }
    if (!preload.includes("DohcDesktopBridge")) {
      failures.push("apps/desktop/src/preload.ts no longer types the bridge as DohcDesktopBridge");
    }
  }
}

// --- rule 4: single owners for duplicated helpers -----------------------------

// 4a. Extension -> media-type tables. Owner: workspace-core mediaTypeForPath.
// Signature: a non-test shipping source file declaring >= 3 distinct media-type
// string literals is a table.
const MEDIA_LITERALS = [
  "text/markdown", "text/csv", "application/json", "application/x-ndjson",
  "image/png", "image/jpeg", "application/pdf", "audio/mp4", "application/vnd.sqlite3",
];
const MEDIA_TABLE_OWNER = "packages/workspace-core/src/paths.ts";
const MEDIA_TABLE_ALLOWLIST = [
  {
    file: "apps/desktop/src/workspaces/workspaceAssets.ts",
    reason: "Protocol-serving ALLOWLIST, deliberately narrower than the shared table: only types a view renders; unknown -> octet-stream so nothing else executes.",
    deleteWhen: "Delete if the dohc-file protocol stops serving binary media directly.",
  },
  {
    file: "apps/web/src/components/UploadFileButton.tsx",
    reason: "The file-picker `accept` attribute — a UI affordance, not detection; the upload's media type still resolves through workspace-core.",
    deleteWhen: "Delete when uploads move to a shared component or drag-and-drop replaces the picker.",
  },
  {
    file: "apps/web/src/backend/postgresBackendClient.ts",
    reason: "Reverse direction: media type -> cloud atom/asset KIND for the API contract. The workspace-fs equivalent is Node-only and cannot ship in the browser bundle.",
    deleteWhen: "Delete when kind mapping moves into a browser-safe shared package (workspace-core or contracts).",
  },
  {
    file: "packages/workspace-postgres/src/repositories/atoms.ts",
    reason: "Reverse direction: stored atom KIND -> contentType projection for reads.",
    deleteWhen: "Delete when atom kinds carry their contentType in the schema.",
  },
  {
    file: "packages/workspace-postgres/src/services/dataImport.ts",
    reason: "Reverse direction: incoming media type -> parser dispatch for cloud data import.",
    deleteWhen: "Delete when cloud import shares the sqlite-worker importData dispatch.",
  },
];

// 4b. Workspace path validators. Owner: workspace-core (validateUserWritePath,
// normalizeAbsolutePath, validateWorkspaceRootChoice). A NEW function named
// validate*/normalize*/sanitize*Path outside workspace-core is a duplicate.
// (Containment RESOLVERS — workspace-fs resolveWorkspacePath, the postgres
// app-scope resolvers — are a different, audited layer: they map already
// validated paths to absolute ones.)
const VALIDATOR_RE = /function\s+(validate|normalize|sanitize)[A-Za-z]*Path\s*\(|const\s+(validate|normalize|sanitize)[A-Za-z]*Path\s*=/;
const VALIDATOR_OWNER_DIR = "packages/workspace-core/";

function scanDuplicates() {
  for (const file of listFiles("apps", "packages", "services")) {
    if (!/\.(ts|tsx|mjs)$/.test(file)) continue;
    const r = rel(file);
    if (/\.test\.|\.spec\./.test(r)) continue;
    const body = readText(file);
    if (body === null) continue;

    const distinct = MEDIA_LITERALS.filter((lit) => body.includes(lit));
    if (distinct.length >= 3 && r !== MEDIA_TABLE_OWNER) {
      if (!MEDIA_TABLE_ALLOWLIST.some((entry) => entry.file === r)) {
        failures.push(
          `${r} declares a media-type table (${distinct.length} literals) — the owner is ${MEDIA_TABLE_OWNER} (mediaTypeForPath); consume it or allowlist with justification`,
        );
      }
    }

    if (VALIDATOR_RE.test(body) && !r.startsWith(VALIDATOR_OWNER_DIR)) {
      failures.push(
        `${r} defines a workspace path validator — the owner is packages/workspace-core (validateUserWritePath); import it instead`,
      );
    }
  }
}

// --- run ----------------------------------------------------------------------

for (const entry of [...FORBIDDEN_ALLOWLIST, ...MEDIA_TABLE_ALLOWLIST]) {
  if (!entry.reason || !entry.deleteWhen) {
    throw new Error(`Allowlist entry for ${entry.file} is missing reason or deleteWhen.`);
  }
}

scanForbidden();
scanBoundaries();
scanDuplicates();

if (failures.length > 0) {
  console.error(`Architecture debt check FAILED (${failures.length} finding${failures.length === 1 ? "" : "s"}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Architecture debt check passed (${FORBIDDEN_ALLOWLIST.length + MEDIA_TABLE_ALLOWLIST.length} documented allowlist entries, ${HISTORICAL_DOCS.size} historical docs).`,
);
