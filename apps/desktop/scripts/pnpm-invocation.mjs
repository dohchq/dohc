import { basename } from "node:path";

export function pnpmInvocation(
  args,
  {
    nodeExecutable = process.execPath,
    pnpmCli = process.env.npm_execpath,
  } = {},
) {
  const cliPath = pnpmCli?.trim();
  if (!cliPath || !basename(cliPath).toLowerCase().startsWith("pnpm")) {
    throw new Error("run UI audit capture through its pnpm package script");
  }

  return {
    command: nodeExecutable,
    args: [cliPath, ...args],
  };
}
