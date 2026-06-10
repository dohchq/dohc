import { spawnSync } from "node:child_process";

// Tests must run under Node 22.13.0: Node 25 breaks 17 @dohc/web tests
// (see execution log Environment section). Pin via PATH prefix.
const pinnedNodeBin = "/home/ice/.local/share/nvm/v22.13.0/bin";
const pnpmBin = "/home/ice/.local/share/pnpm/.tools/pnpm/10.24.0/bin";

const env = {
  ...process.env,
  PATH: `${pinnedNodeBin}:${pnpmBin}:${process.env.PATH ?? ""}`,
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
