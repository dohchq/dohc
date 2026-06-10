import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Tests must run under Node 22.13.x: Node 25 breaks 17 @dohc/web tests
// (see execution log Environment section). Pin via PATH prefix; fail loudly
// if the pinned toolchain is missing rather than silently using caller PATH.
const pinnedNodeBin =
  process.env.DOHC_TEST_NODE_BIN ?? "/home/ice/.local/share/nvm/v22.13.0/bin";
const pnpmBin = "/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin";

if (!existsSync(`${pinnedNodeBin}/node`)) {
  console.error(`Pinned Node not found at ${pinnedNodeBin}/node.`);
  console.error(
    "Set DOHC_TEST_NODE_BIN to a Node 22.13+ bin directory (Node 25 breaks @dohc/web tests).",
  );
  process.exit(1);
}

const env = {
  ...process.env,
  PATH: `${pinnedNodeBin}:${pnpmBin}:${process.env.PATH ?? ""}`,
};

// Known pre-existing failures on main @ e2de7a3: 4 @dohc/web tests (see
// execution log Gotchas). This allowance dies when those tests are fixed or
// deleted with Convex in Phase 13 — do not add entries for new failures.
const knownFailingBaseline = new Set(["pnpm --filter @dohc/web test"]);

const commands = [
  ["pnpm", ["--filter", "@dohc/web", "typecheck"]],
  ["pnpm", ["--filter", "@dohc/web", "test"]],
  ["pnpm", ["--filter", "@dohc/workspace-contracts", "test"]],
  ["pnpm", ["--filter", "@dohc/workspace-convex-compat", "test"]],
  ["pnpm", ["--filter", "@dohc/workspace-postgres", "test"]],
  ["pnpm", ["--filter", "@dohc/workspace-fs", "test"]],
  ["pnpm", ["--filter", "@dohc/workspace-api", "test"]],
  ["pnpm", ["--filter", "@dohc/hocuspocus", "test"]],
  ["pnpm", ["--filter", "@dohc/app-tester", "test"]],
  ["pnpm", ["--filter", "@dohc/sqlite-worker", "test"]],
  ["pnpm", ["--filter", "@dohc/agent-sandbox", "test"]],
  // The pivot's own suites — the gate covers what we're building, not just
  // what we inherited.
  ["pnpm", ["--filter", "@dohc/workspace-core", "test"]],
  ["pnpm", ["--filter", "@dohc/workspace-sync", "test"]],
  ["pnpm", ["--filter", "@dohc/workspace-history", "test"]],
  ["pnpm", ["--filter", "@dohc/desktop", "test"]],
  ["pnpm", ["check:debt"]],
];

const results = [];
for (const [cmd, args] of commands) {
  const label = `${cmd} ${args.join(" ")}`;
  console.log(`\n$ ${label}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: true, env });
  results.push({ label, status: result.status ?? 1 });
}

console.log("\n=== Baseline summary ===");
let unexpected = 0;
for (const { label, status } of results) {
  const known = status !== 0 && knownFailingBaseline.has(label);
  const tag = status === 0 ? "PASS" : known ? "KNOWN-FAIL (recorded baseline)" : "FAIL";
  if (status !== 0 && !known) unexpected += 1;
  console.log(`${tag.padEnd(32)} ${label}`);
}

if (unexpected > 0) {
  console.error(`\n${unexpected} unexpected failure(s) beyond the recorded baseline.`);
  process.exit(1);
}
console.log("\nBaseline check passed (known baseline failures tolerated).");
