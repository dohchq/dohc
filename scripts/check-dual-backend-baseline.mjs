import { spawnSync } from "node:child_process";

const commands = [
  ["pnpm", ["--filter", "@dohc/web", "typecheck"]],
  ["pnpm", ["--filter", "@dohc/web", "test"]],
  ["pnpm", ["--filter", "@dohc/app-tester", "test"]],
  ["pnpm", ["--filter", "@dohc/hocuspocus", "test"]],
  ["pnpm", ["--filter", "@dohc/sqlite-worker", "test"]],
];

for (const [cmd, args] of commands) {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: true });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
