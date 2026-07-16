#!/usr/bin/env node
// build-reviewer-packet.mjs — assemble a reviewer packet for one rust-engine
// shard, or validate program-table integrity.
//
//   node build-reviewer-packet.mjs <shard-id> [--diff <ref>] [--base <ref>] [--out <file>]
//   node build-reviewer-packet.mjs --check
//   node build-reviewer-packet.mjs --self-test
//
// Packet contents (single markdown file, default rust-engine-packet-<shard-id>.md
// in the current directory): the SHARDS.tsv row, the shard's resolved
// BEHAVIOR_INVENTORY.tsv rows, the relevant TS source-file list, the git diff
// (base...ref, when --diff is given), the ported-test list, and pointers to the
// contract docs relevant to the shard's proposed_home crates. Reviewers receive
// this packet and nothing else — see the plan's "Multi-agent orchestration"
// cell and TEST_ORACLE.md.
//
// Behavior-ID resolution: tokens in the shard's behavior_ids column that match
// inventory behavior_ids are used directly; otherwise rows are derived from the
// shard's owned crates (crates/dohc-engine-X/** -> proposed_home contains
// dohc-engine-X), narrowed by owned module stems (src/<stem>* patterns) when
// that narrowing is non-empty.
//
// --check validates referential integrity and exits nonzero on problems:
// malformed TSV rows, duplicate shard IDs, unknown shard deps, duplicate
// behavior IDs, and Gate-0 program files on disk that no shard's owned_paths
// covers. Intended as a CI hook on the program tables.
//
// Requires Node >= 22. Zero npm dependencies. Windows-path safe.

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROGRAM_DIR_REL = "docs/superpowers/plans/rust-engine";
const PLANS_DIR_REL = "docs/superpowers/plans";

const CONTRACT_DOCS_BASE = [
  "docs/superpowers/plans/2026-07-16-dohc-rust-engine-rewrite.md",
  `${PROGRAM_DIR_REL}/TEST_ORACLE.md`,
  `${PROGRAM_DIR_REL}/PORTING.md`,
  `${PROGRAM_DIR_REL}/LANGUAGE_SEMANTICS_MATRIX.md`,
  `${PROGRAM_DIR_REL}/DECISIONS.md`,
  `${PROGRAM_DIR_REL}/CRATE_GRAPH.md`,
];

const CONTRACT_DOCS_BY_CRATE = {
  "dohc-engine-protocol": [`${PROGRAM_DIR_REL}/ENGINE_PROTOCOL.md`],
  "dohc-engine-storage": [`${PROGRAM_DIR_REL}/STORAGE_AND_RECOVERY.md`],
  "dohc-engine-files": [`${PROGRAM_DIR_REL}/STORAGE_AND_RECOVERY.md`],
  "dohc-engine-crypto": [`${PROGRAM_DIR_REL}/UNSAFE.md`],
  "dohc-engine-sync": [`${PROGRAM_DIR_REL}/ENGINE_PROTOCOL.md`],
  "dohc-workspace-engine": [`${PROGRAM_DIR_REL}/ENGINE_PROTOCOL.md`],
};

const CUTOVER_DOC = `${PROGRAM_DIR_REL}/CUTOVER_AND_ROLLBACK.md`;
const MAX_DIFF_LINES = 4000;

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function toPosix(p) {
  return p.replaceAll("\\", "/");
}

export function parseTsv(text, label = "tsv") {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error(`${label}: empty file`);
  const header = lines[0].split("\t");
  const rows = [];
  const problems = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i].split("\t");
    if (cells.length !== header.length) {
      problems.push(
        `${label}: line ${i + 1} has ${cells.length} columns, expected ${header.length}`,
      );
      continue;
    }
    const row = {};
    for (let c = 0; c < header.length; c += 1) row[header[c]] = cells[c];
    rows.push(row);
  }
  return { header, rows, problems };
}

// Strip trailing parenthetical annotations: "apps/x.ts (flagged wiring)" -> "apps/x.ts".
function stripAnnotation(token) {
  return token.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function isPathLike(token) {
  return token.includes("/") || token.includes(".");
}

function ownedPathTokens(ownedPaths) {
  return (ownedPaths ?? "")
    .split(";")
    .map((t) => stripAnnotation(t))
    .filter((t) => t && t !== "-" && isPathLike(t));
}

// Single-level brace expansion: "src/{a,b}*" -> ["src/a*", "src/b*"].
export function expandBraces(pattern) {
  const match = pattern.match(/^(.*)\{([^}]*)\}(.*)$/);
  if (!match) return [pattern];
  return match[2]
    .split(",")
    .flatMap((option) => expandBraces(`${match[1]}${option.trim()}${match[3]}`));
}

// Glob over posix-normalized relative paths. Supports ** (any depth), *
// (within a segment), and plain prefixes (a bare file or directory path
// matches itself and everything under it).
export function makePathMatcher(pattern) {
  const posix = toPosix(pattern);
  const expanded = expandBraces(posix);
  const regexes = expanded.map((pat) => {
    let source = "";
    for (let i = 0; i < pat.length; i += 1) {
      const ch = pat[i];
      if (ch === "*") {
        if (pat[i + 1] === "*") {
          source += ".*";
          i += 1;
          if (pat[i + 1] === "/") i += 1;
        } else {
          source += "[^/]*";
        }
      } else if ("\\^$.|?+()[]{}".includes(ch)) {
        source += `\\${ch}`;
      } else {
        source += ch;
      }
    }
    const hasGlob = pat.includes("*");
    return new RegExp(hasGlob ? `^${source}$` : `^${source}(/.*)?$`);
  });
  return (path) => {
    const candidate = toPosix(path);
    return regexes.some((re) => re.test(candidate));
  };
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function findRepoRoot() {
  try {
    return git(SCRIPT_DIR, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return resolve(SCRIPT_DIR, "..", "..");
  }
}

// ---------------------------------------------------------------------------
// table loading
// ---------------------------------------------------------------------------

export function loadTables(root) {
  const programDir = join(root, PROGRAM_DIR_REL);
  const shardsPath = join(programDir, "SHARDS.tsv");
  const inventoryPath = join(programDir, "BEHAVIOR_INVENTORY.tsv");
  const classificationPath = join(programDir, "TEST_CLASSIFICATION.tsv");
  // The program tables are owned by other shards (SHARDS.tsv: INTEGRATOR;
  // BEHAVIOR_INVENTORY.tsv: R01-INVENTORY, PR #138) and land on main via their
  // own PRs — this tool requires a checkout that already contains them.
  if (!existsSync(shardsPath)) {
    throw new Error(
      `SHARDS.tsv not found at ${shardsPath} — run from a checkout containing the program tables (main after R01-INVENTORY / PR #138)`,
    );
  }
  if (!existsSync(inventoryPath)) {
    throw new Error(
      `BEHAVIOR_INVENTORY.tsv not found at ${inventoryPath} — run from a checkout containing the program tables (main after R01-INVENTORY / PR #138)`,
    );
  }
  const shards = parseTsv(readFileSync(shardsPath, "utf8"), "SHARDS.tsv");
  const inventory = parseTsv(readFileSync(inventoryPath, "utf8"), "BEHAVIOR_INVENTORY.tsv");
  const classification = existsSync(classificationPath)
    ? parseTsv(readFileSync(classificationPath, "utf8"), "TEST_CLASSIFICATION.tsv")
    : { header: [], rows: [], problems: [] };
  return { shards, inventory, classification };
}

// ---------------------------------------------------------------------------
// behavior resolution
// ---------------------------------------------------------------------------

function cratesFromOwnedPaths(ownedPaths) {
  const crates = new Set();
  for (const token of ownedPathTokens(ownedPaths)) {
    const match = toPosix(token).match(/^crates\/([a-z0-9-]+)/i);
    if (match) crates.add(match[1]);
  }
  return [...crates];
}

function moduleStemsFromOwnedPaths(ownedPaths) {
  const stems = new Set();
  for (const token of ownedPathTokens(ownedPaths)) {
    const posix = toPosix(token);
    const match = posix.match(/\/src\/(.+)$/);
    if (!match) continue;
    for (const part of expandBraces(match[1])) {
      const stem = part.replace(/\*.*$/, "").replace(/\.rs$/, "").trim();
      if (stem && stem !== "lib" && !stem.includes("/")) stems.add(stem.toLowerCase());
    }
  }
  return [...stems];
}

export function resolveShardBehaviors(shard, inventoryRows) {
  const byId = new Map(inventoryRows.map((row) => [row.behavior_id, row]));
  const tokens = (shard.behavior_ids ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter((t) => t && t !== "-");
  const direct = tokens.filter((t) => byId.has(t)).map((t) => byId.get(t));
  if (direct.length > 0 && direct.length === tokens.length) {
    return { rows: direct, method: "explicit behavior_ids", note: null };
  }

  const crates = cratesFromOwnedPaths(shard.owned_paths);
  let derived = [];
  let note = null;
  if (crates.length > 0) {
    derived = inventoryRows.filter((row) =>
      crates.some((crate) => (row.proposed_home ?? "").includes(crate)),
    );
    const stems = moduleStemsFromOwnedPaths(shard.owned_paths);
    if (stems.length > 0 && derived.length > 0) {
      const narrowed = derived.filter((row) => {
        const haystack = `${row.behavior_id} ${row.proposed_home}`.toLowerCase();
        return stems.some((stem) => haystack.includes(stem));
      });
      if (narrowed.length > 0) {
        derived = narrowed;
      } else {
        note = `module stems [${stems.join(", ")}] matched no rows; kept crate-level match`;
      }
    }
  }

  const merged = new Map();
  for (const row of [...direct, ...derived]) merged.set(row.behavior_id, row);
  return {
    rows: [...merged.values()],
    method:
      crates.length > 0
        ? `derived from owned crates [${crates.join(", ")}]${direct.length ? " + explicit ids" : ""}`
        : direct.length > 0
          ? "explicit behavior_ids (partial: some tokens are group labels)"
          : "no crate-owned paths; behavior_ids column holds group labels only",
    note,
  };
}

// ---------------------------------------------------------------------------
// --check: referential integrity
// ---------------------------------------------------------------------------

export function runCheck({ shards, inventory, classification }, programFiles) {
  const problems = [
    ...shards.problems,
    ...inventory.problems,
    ...(classification?.problems ?? []),
  ];

  const shardIds = new Set();
  for (const row of shards.rows) {
    if (shardIds.has(row.shard_id)) problems.push(`duplicate shard_id: ${row.shard_id}`);
    shardIds.add(row.shard_id);
  }

  for (const row of shards.rows) {
    for (const dep of (row.deps ?? "").split(";").map((d) => d.trim())) {
      if (!dep || dep === "-") continue;
      if (!shardIds.has(dep)) {
        problems.push(`shard ${row.shard_id}: unknown dep "${dep}"`);
      }
    }
  }

  const behaviorIds = new Set();
  for (const row of inventory.rows) {
    if (behaviorIds.has(row.behavior_id)) {
      problems.push(`duplicate behavior_id: ${row.behavior_id}`);
    }
    behaviorIds.add(row.behavior_id);
  }

  // Gate-0 program files must each be owned by some shard's owned_paths.
  const matchers = shards.rows.flatMap((row) =>
    ownedPathTokens(row.owned_paths).map((token) => makePathMatcher(token)),
  );
  for (const file of programFiles) {
    const posix = toPosix(file);
    if (!matchers.some((matches) => matches(posix))) {
      problems.push(`unowned Gate-0 program file: ${posix} (no shard's owned_paths covers it)`);
    }
  }

  return problems;
}

// Gate-0 program files: everything under the rust-engine program directory,
// plus rust-engine plan documents at the plans root. Historical (non-program)
// plans are out of scope for the ownership check.
function listProgramFiles(root) {
  const out = [];
  const walk = (relDir) => {
    const abs = join(root, relDir);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk(PROGRAM_DIR_REL);
  const plansAbs = join(root, PLANS_DIR_REL);
  if (existsSync(plansAbs)) {
    for (const entry of readdirSync(plansAbs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.includes("rust-engine")) {
        out.push(`${PLANS_DIR_REL}/${entry.name}`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// packet assembly
// ---------------------------------------------------------------------------

const PATH_TOKEN_RE = /(?:packages|apps|crates|services|tools|docs)\/[\w@./-]+/g;

function extractRepoPaths(text) {
  return [...(text ?? "").matchAll(PATH_TOKEN_RE)].map((m) => m[0].replace(/[.,;:]+$/, ""));
}

function sourceFilesForBehaviors(rows) {
  const files = new Set();
  for (const row of rows) {
    for (const field of [row.module, row.callers]) {
      for (const path of extractRepoPaths(field)) files.add(path);
    }
  }
  return [...files].sort();
}

function portedTestsForShard(shard, behaviorRows, classificationRows, sourceFiles) {
  const tests = new Map(); // path -> annotation
  const shardTestTokens = (shard.test_files ?? "")
    .split(";")
    .map((t) => t.trim())
    .filter((t) => t && t !== "-");
  for (const token of shardTestTokens) {
    if (isPathLike(token)) tests.set(toPosix(token), "named in SHARDS.tsv");
    else tests.set(token, "SHARDS.tsv test-suite label (not a file path)");
  }
  const sourceStems = new Set(
    sourceFiles.map((f) => toPosix(f).split("/").pop().replace(/\.tsx?$/, "")),
  );
  for (const row of classificationRows) {
    const file = toPosix(row.test_file ?? "");
    const stem = file.split("/").pop()?.replace(/(\.\w+)?\.test\.tsx?$/, "");
    if (stem && sourceStems.has(stem)) {
      tests.set(
        file,
        `TEST_CLASSIFICATION: ${row.classification}, priority ${row.port_priority}`,
      );
    }
  }
  // current_tests is prose; extract just the test-file names it mentions.
  const byBehavior = new Map(); // test file name -> Set of behavior ids
  for (const row of behaviorRows) {
    for (const match of (row.current_tests ?? "").matchAll(/[\w.-]+\.test\.tsx?/g)) {
      if (!byBehavior.has(match[0])) byBehavior.set(match[0], new Set());
      byBehavior.get(match[0]).add(row.behavior_id);
    }
  }
  for (const [name, ids] of byBehavior) {
    const already = [...tests.keys()].find((k) => k.endsWith(`/${name}`) || k === name);
    const annotation = `covers ${[...ids].join(", ")} (BEHAVIOR_INVENTORY current_tests)`;
    if (already) tests.set(already, `${tests.get(already)}; ${annotation}`);
    else tests.set(name, annotation);
  }
  return [...tests.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function contractDocsForShard(shard, behaviorRows, root) {
  const docs = new Set(CONTRACT_DOCS_BASE);
  const crates = new Set(cratesFromOwnedPaths(shard.owned_paths));
  for (const row of behaviorRows) {
    for (const crate of Object.keys(CONTRACT_DOCS_BY_CRATE)) {
      if ((row.proposed_home ?? "").includes(crate)) crates.add(crate);
    }
  }
  for (const crate of crates) {
    for (const doc of CONTRACT_DOCS_BY_CRATE[crate] ?? []) docs.add(doc);
  }
  if (/cutover|reset/i.test(`${shard.shard_id} ${shard.behavior_ids}`)) docs.add(CUTOVER_DOC);
  return [...docs].sort().map((doc) => ({
    doc,
    exists: existsSync(join(root, doc)),
  }));
}

// A fence longer than any backtick run in the content, so diff content can
// never close the fence and spoof later packet sections.
export function makeFence(texts) {
  const maxRun = Math.max(
    0,
    ...texts.flatMap((text) => [...text.matchAll(/`+/g)].map((m) => m[0].length)),
  );
  return "`".repeat(Math.max(3, maxRun + 1));
}

function diffSection(root, ref, base) {
  const range = `${base}...${ref}`;
  let stat;
  let patch;
  try {
    stat = git(root, ["diff", "--stat", range]);
    patch = git(root, ["diff", range]);
  } catch (error) {
    // The packet is the ENTIRE review input; a missing diff must fail the
    // run, never ship as a paragraph inside a "successful" packet.
    throw new Error(
      `git diff ${range} failed: ${String(error.message ?? error).split("\n")[0]}`,
    );
  }
  const lines = patch.split("\n");
  const truncated = lines.length > MAX_DIFF_LINES;
  const body = truncated ? lines.slice(0, MAX_DIFF_LINES).join("\n") : patch;
  const fence = makeFence([stat, body]);
  return [
    `\`git diff ${range}\`\n`,
    fence,
    stat.trimEnd(),
    fence,
    "",
    `${fence}diff`,
    body.trimEnd(),
    fence,
    truncated ? `\n_[diff truncated at ${MAX_DIFF_LINES} lines — review the branch directly]_` : "",
    "",
  ].join("\n");
}

function tsvRowBlock(row, header) {
  return header.map((col) => `- **${col}**: ${row[col] ?? ""}`).join("\n");
}

export function buildPacket({ shard, shardsHeader, behaviors, inventoryHeader, root, diffRef, diffBase, classificationRows }) {
  const sourceFiles = sourceFilesForBehaviors(behaviors.rows);
  const tests = portedTestsForShard(shard, behaviors.rows, classificationRows, sourceFiles);
  const docs = contractDocsForShard(shard, behaviors.rows, root);
  // Honest provenance: the tables are read from the working tree. If the
  // program dir differs from HEAD (modified or untracked files), say so —
  // never label working-tree data as committed HEAD state.
  let provenance = "git provenance unavailable (not a repository)";
  try {
    const head = git(root, ["rev-parse", "--short", "HEAD"]).trim();
    const dirty = git(root, ["status", "--porcelain", "--", PLANS_DIR_REL]).trim();
    provenance = dirty
      ? `WORKING TREE with uncommitted program-table changes (HEAD ${head}; ${dirty.split("\n").length} dirty/untracked path(s) under ${PLANS_DIR_REL})`
      : `committed HEAD ${head} (program tables clean)`;
  } catch {}

  const parts = [];
  parts.push(`# Reviewer packet — shard ${shard.shard_id}`);
  parts.push("");
  parts.push(
    `> Generated by tools/rust-engine-program/build-reviewer-packet.mjs. Tables read from: ${provenance}.`,
  );
  parts.push(
    "> This packet plus the diff is the ENTIRE review input — reviewers never see the implementer's reasoning (plan, \"The cell\").",
  );
  parts.push("");
  parts.push("## Shard row (SHARDS.tsv)");
  parts.push("");
  parts.push(tsvRowBlock(shard, shardsHeader));
  parts.push("");
  parts.push(`## Behavior inventory rows (${behaviors.rows.length})`);
  parts.push("");
  parts.push(`_Resolution: ${behaviors.method}${behaviors.note ? ` — ${behaviors.note}` : ""}_`);
  parts.push("");
  for (const row of behaviors.rows) {
    parts.push(`### ${row.behavior_id} (${row.risk_tier})`);
    parts.push("");
    parts.push(tsvRowBlock(row, inventoryHeader));
    parts.push("");
  }
  parts.push(`## TS source files (${sourceFiles.length})`);
  parts.push("");
  for (const file of sourceFiles) {
    parts.push(`- ${file}${existsSync(join(root, file)) ? "" : " _(missing on this checkout)_"}`);
  }
  parts.push("");
  parts.push(`## Ported / relevant tests (${tests.length})`);
  parts.push("");
  for (const [file, why] of tests) parts.push(`- ${file} — ${why}`);
  parts.push("");
  parts.push("## Contract docs for this shard's crates");
  parts.push("");
  for (const { doc, exists } of docs) {
    parts.push(`- ${doc}${exists ? "" : " _(not yet written — flag if this shard needs it)_"}`);
  }
  parts.push("");
  parts.push("## Diff");
  parts.push("");
  parts.push(
    diffRef
      ? diffSection(root, diffRef, diffBase)
      : "_No --diff ref supplied; review the shard branch directly (SHARDS.tsv branch column)._",
  );
  parts.push("");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// self-test
// ---------------------------------------------------------------------------

const FIXTURE_SHARDS = [
  "shard_id\tbehavior_ids\twave\tdeps\towned_paths\ttest_files\trisk_tier\treview_tier\tstatus\tbranch\tpr",
  "INTEGRATOR\tprogram-state\t-\t-\tdocs/superpowers/plans/rust-engine/SHARDS.tsv\t-\tlow\tdocs\tin progress\t-\t-",
  "F-STORE\tstorage-core\t1\tINTEGRATOR\tcrates/dohc-engine-storage/**\tported\tcritical\t1\tplanned\t-\t-",
  "F-CHATS\tchats-send-message\t2\tF-STORE\tcrates/dohc-engine-domain/src/chats*\tported\thigh\t2\tplanned\t-\t-",
].join("\n");

const FIXTURE_SHARDS_BAD = [
  "shard_id\tbehavior_ids\twave\tdeps\towned_paths\ttest_files\trisk_tier\treview_tier\tstatus\tbranch\tpr",
  "F-STORE\tstorage-core\t1\tF-GHOST\tcrates/dohc-engine-storage/**\tported\tcritical\t1\tplanned\t-\t-",
  "F-STORE\tstorage-core\t1\t-\tcrates/dohc-engine-storage/**\tported\tcritical\t1\tplanned\t-\t-",
  "F-BROKEN\tonly three cells",
].join("\n");

const FIXTURE_INVENTORY = [
  "behavior_id\tmodule\timplementation\tcallers\tio_contract\ttables_files\ttxn_ack_boundary\tordering_idempotency\tsecurity_class\tcurrent_tests\tproposed_home\trisk_tier",
  "storage-open\tpackages/workspace-engine/src/engineDbSchema.ts\tengineDbSchema.ts:1\tpackages/workspace-engine/src/versionedTextStore.ts\tin->out\tschema_version\tcommit\tidempotent\tworkspace-scoped\tactiveVersion.test.ts\tdohc-engine-storage::schema\tcritical",
  "chats-send-message\tpackages/workspace-engine/src/linkedChatStore.ts\tlinkedChatStore.ts:900\tapps/desktop/src/main.ts\tin->out\tchat_messages\tcommit\texactly-once\tworkspace-scoped\tlinkedChatStore.test.ts\tdohc-engine-domain (chats)\thigh",
  "versions-write\tpackages/workspace-engine/src/versionedTextStore.ts\tversionedTextStore.ts:4700\tapps/desktop/src/workspaces/workspaceEngineCapture.ts\tin->out\tsnapshots\tcommit\texactly-once\tworkspace-scoped\tversionedTextStore.test.ts\tdohc-engine-domain::versions\tcritical",
].join("\n");

const FIXTURE_INVENTORY_BAD = [
  "behavior_id\tmodule\timplementation\tcallers\tio_contract\ttables_files\ttxn_ack_boundary\tordering_idempotency\tsecurity_class\tcurrent_tests\tproposed_home\trisk_tier",
  "storage-open\tm\ti\tc\tio\tt\ttx\tord\tsec\ttests\tdohc-engine-storage::schema\tcritical",
  "storage-open\tm\ti\tc\tio\tt\ttx\tord\tsec\ttests\tdohc-engine-storage::schema\tcritical",
].join("\n");

function selfTest() {
  let failures = 0;
  const check = (name, condition) => {
    if (condition) {
      process.stdout.write(`  ok   ${name}\n`);
    } else {
      failures += 1;
      process.stdout.write(`  FAIL ${name}\n`);
    }
  };

  // parseTsv
  const shards = parseTsv(FIXTURE_SHARDS, "fixture-shards");
  check("parseTsv: 3 shard rows", shards.rows.length === 3);
  check("parseTsv: header preserved", shards.header[0] === "shard_id");
  const badShards = parseTsv(FIXTURE_SHARDS_BAD, "fixture-shards-bad");
  check("parseTsv: malformed row reported", badShards.problems.length === 1);

  // glob matching
  const m1 = makePathMatcher("crates/dohc-engine-storage/**");
  check("glob: ** depth", m1("crates/dohc-engine-storage/src/schema/mod.rs"));
  check("glob: ** rejects sibling", !m1("crates/dohc-engine-domain/src/lib.rs"));
  const m2 = makePathMatcher("crates/x/src/{a,b}*");
  check("glob: brace + star", m2("crates/x/src/a_mod.rs") && m2("crates/x/src/b.rs"));
  check("glob: brace rejects other", !m2("crates/x/src/c.rs"));
  const m3 = makePathMatcher("docs/superpowers/plans/rust-engine/SHARDS.tsv");
  check("glob: exact file", m3("docs/superpowers/plans/rust-engine/SHARDS.tsv"));
  check("glob: exact rejects other", !m3("docs/superpowers/plans/rust-engine/DECISIONS.md"));
  check(
    "glob: windows separators normalized",
    m1("crates\\dohc-engine-storage\\src\\lib.rs"),
  );
  const m4 = makePathMatcher("apps/desktop/src/main.ts (flagged wiring)".replace(/\s*\([^)]*\)$/, ""));
  check("glob: annotation stripped upstream", m4("apps/desktop/src/main.ts"));

  // behavior resolution
  const inventory = parseTsv(FIXTURE_INVENTORY, "fixture-inventory");
  const storeShard = shards.rows.find((r) => r.shard_id === "F-STORE");
  const storeResolved = resolveShardBehaviors(storeShard, inventory.rows);
  check(
    "resolve: crate-derived rows",
    storeResolved.rows.length === 1 && storeResolved.rows[0].behavior_id === "storage-open",
  );
  const chatShard = shards.rows.find((r) => r.shard_id === "F-CHATS");
  const chatResolved = resolveShardBehaviors(chatShard, inventory.rows);
  check(
    "resolve: explicit id wins",
    chatResolved.rows.some((r) => r.behavior_id === "chats-send-message"),
  );
  check(
    "resolve: module stem narrows out versions row",
    !chatResolved.rows.some((r) => r.behavior_id === "versions-write"),
  );

  // --check on a good fixture set
  const goodProblems = runCheck(
    { shards, inventory },
    ["docs/superpowers/plans/rust-engine/SHARDS.tsv"],
  );
  check("check: clean fixture has no problems", goodProblems.length === 0);

  // --check on a bad fixture set
  const badInventory = parseTsv(FIXTURE_INVENTORY_BAD, "fixture-inventory-bad");
  const badClassification = parseTsv(
    "test_file\tline_count\tclassification\thooks_or_sql_used\tport_priority\tnotes_inline\nbroken row with two cells\tonly-two",
    "fixture-classification-bad",
  );
  const badProblems = runCheck(
    { shards: badShards, inventory: badInventory, classification: badClassification },
    ["docs/superpowers/plans/rust-engine/UNOWNED.md"],
  );
  check(
    "check: detects unknown dep",
    badProblems.some((p) => p.includes('unknown dep "F-GHOST"')),
  );
  check(
    "check: detects duplicate shard id",
    badProblems.some((p) => p.includes("duplicate shard_id: F-STORE")),
  );
  check(
    "check: detects duplicate behavior id",
    badProblems.some((p) => p.includes("duplicate behavior_id: storage-open")),
  );
  check(
    "check: detects unowned program file",
    badProblems.some((p) => p.includes("unowned Gate-0 program file")),
  );
  check(
    "check: reports malformed row",
    badProblems.some((p) => p.includes("fixture-shards-bad: line 4")),
  );
  check(
    "check: includes classification parse failures",
    badProblems.some((p) => p.includes("fixture-classification-bad: line 2")),
  );

  // markdown fence safety: fence must outrun any backtick run in the diff
  const hostile = "diff --git a/x b/x\n+```\n+`````evil section\n";
  const fence = makeFence([hostile, ""]);
  check("fence: longer than longest backtick run", fence.length === 6);
  check("fence: minimum three backticks", makeFence(["no ticks"]) === "```");

  // packet assembly (no git diff), against a throwaway dir
  const tmp = mkdtempSync(join(tmpdir(), "packet-selftest-"));
  try {
    const packet = buildPacket({
      shard: storeShard,
      shardsHeader: shards.header,
      behaviors: storeResolved,
      inventoryHeader: inventory.header,
      root: tmp,
      diffRef: null,
      diffBase: "main",
      classificationRows: [],
    });
    check("packet: names the shard", packet.includes("# Reviewer packet — shard F-STORE"));
    check(
      "packet: non-repo provenance labeled honestly",
      packet.includes("git provenance unavailable"),
    );
    check("packet: contains behavior row", packet.includes("### storage-open (critical)"));
    check(
      "packet: lists TS source file",
      packet.includes("packages/workspace-engine/src/engineDbSchema.ts"),
    );
    check(
      "packet: storage crate pulls STORAGE_AND_RECOVERY.md",
      packet.includes("STORAGE_AND_RECOVERY.md"),
    );
    check("packet: no-diff note", packet.includes("No --diff ref supplied"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  process.stdout.write(failures === 0 ? "self-test: PASS\n" : `self-test: ${failures} FAILURES\n`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();

  const root = findRepoRoot();

  if (args.includes("--check")) {
    let tables;
    try {
      tables = loadTables(root);
    } catch (error) {
      fail(String(error.message ?? error));
    }
    const problems = runCheck(tables, listProgramFiles(root));
    if (problems.length > 0) {
      for (const problem of problems) process.stderr.write(`check: ${problem}\n`);
      process.stderr.write(`check: ${problems.length} problem(s)\n`);
      process.exit(1);
    }
    process.stdout.write(
      `check: OK (${tables.shards.rows.length} shards, ${tables.inventory.rows.length} behaviors)\n`,
    );
    return;
  }

  const positional = [];
  let diffRef = null;
  let diffBase = null;
  let outFile = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--diff") diffRef = args[++i] ?? fail("--diff requires a ref");
    else if (args[i] === "--base") diffBase = args[++i] ?? fail("--base requires a ref");
    else if (args[i] === "--out") outFile = args[++i] ?? fail("--out requires a path");
    else if (args[i].startsWith("--")) fail(`unknown flag ${args[i]}`);
    else positional.push(args[i]);
  }
  if (positional.length !== 1) {
    fail(
      "usage: node build-reviewer-packet.mjs <shard-id> [--diff <ref>] [--base <ref>] [--out <file>] | --check | --self-test",
    );
  }
  const shardId = positional[0];

  let tables;
  try {
    tables = loadTables(root);
  } catch (error) {
    fail(String(error.message ?? error));
  }
  const shard = tables.shards.rows.find((row) => row.shard_id === shardId);
  if (!shard) {
    fail(
      `unknown shard "${shardId}" — known: ${tables.shards.rows.map((r) => r.shard_id).join(", ")}`,
    );
  }
  if (!diffBase) {
    diffBase = "origin/main";
    try {
      git(root, ["rev-parse", "--verify", "--quiet", "origin/main"]);
    } catch {
      diffBase = "main";
    }
  }

  const behaviors = resolveShardBehaviors(shard, tables.inventory.rows);
  let packet;
  try {
    packet = buildPacket({
      shard,
      shardsHeader: tables.shards.header,
      behaviors,
      inventoryHeader: tables.inventory.header,
      root,
      diffRef,
      diffBase,
      classificationRows: tables.classification.rows,
    });
  } catch (error) {
    // e.g. an unresolvable --diff/--base ref: exit nonzero, write nothing.
    fail(String(error.message ?? error));
  }
  const target = resolve(outFile ?? `rust-engine-packet-${shardId}.md`);
  writeFileSync(target, packet, "utf8");
  process.stdout.write(
    `packet written: ${target} (${behaviors.rows.length} behavior rows, ${behaviors.method})\n`,
  );
}

main();
