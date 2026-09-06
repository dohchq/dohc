import { spawn } from "node:child_process";

const { command, args } = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"));
const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let spawnFailed = false;
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once("error", (error) => { spawnFailed = true; console.error(error.message); process.exitCode = 1; });
// Keep the job owner alive until inherited output pipes also close.
child.once("close", (code) => { if (!spawnFailed) process.exitCode = code ?? 1; });
