// Trusted relay for one agent probe or run. The owner sends the admission only
// after this process joins the job, so the command and everything it starts
// belong to that job. Without a valid admission nothing starts.
import { spawn } from "node:child_process";

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { command, args, windowsVerbatimArguments, cwd, env, input } = JSON.parse(Buffer.concat(chunks).toString("utf8")) ?? {};
  if (typeof command !== "string" || !Array.isArray(args) || !args.every(arg => typeof arg === "string") ||
      typeof windowsVerbatimArguments !== "boolean" || typeof cwd !== "string" ||
      typeof env !== "object" || env === null || Array.isArray(env) || !Object.values(env).every(value => typeof value === "string") ||
      (input !== undefined && typeof input !== "string")) {
    throw new Error("Invalid agent probe admission.");
  }
  // Inherited output: the command and its descendants write straight into the
  // owner's pipes, which reach EOF only after every writer is gone. A run's
  // prompt arrives as input and ends the command's stdin.
  const child = spawn(command, args, { cwd, env, windowsHide: true, windowsVerbatimArguments, stdio: [input === undefined ? "ignore" : "pipe", "inherit", "inherit"] });
  // A command that exits before reading its input breaks the pipe; its exit code reports that.
  if (input !== undefined) child.stdin?.on("error", () => {}).end(input);
  let failed = false;
  // A spawn failure need not be followed by close.
  child.on("error", error => { failed = true; process.exitCode = 1; console.error(error.message); });
  child.on("close", code => { process.exitCode = failed ? 1 : code ?? 1; });
} catch (error) { console.error(error.message); process.exitCode = 1; }
