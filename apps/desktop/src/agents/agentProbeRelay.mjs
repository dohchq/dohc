// Trusted relay for one agent probe. The owner sends the admission only after
// this process joins the probe's job, so the command and everything it starts
// belong to that job. Without a valid admission nothing starts.
import { spawn } from "node:child_process";

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { command, args, windowsVerbatimArguments, cwd, env } = JSON.parse(Buffer.concat(chunks).toString("utf8")) ?? {};
  if (typeof command !== "string" || !Array.isArray(args) || !args.every(arg => typeof arg === "string") ||
      typeof windowsVerbatimArguments !== "boolean" || typeof cwd !== "string" ||
      typeof env !== "object" || env === null || Array.isArray(env) || !Object.values(env).every(value => typeof value === "string")) {
    throw new Error("Invalid agent probe admission.");
  }
  // Inherited output: the command and its descendants write straight into the
  // owner's pipes, which reach EOF only after every writer is gone.
  const child = spawn(command, args, { cwd, env, windowsHide: true, windowsVerbatimArguments, stdio: ["ignore", "inherit", "inherit"] });
  let failed = false;
  // A spawn failure need not be followed by close.
  child.on("error", error => { failed = true; process.exitCode = 1; console.error(error.message); });
  child.on("close", code => { process.exitCode = failed ? 1 : code ?? 1; });
} catch (error) { console.error(error.message); process.exitCode = 1; }
