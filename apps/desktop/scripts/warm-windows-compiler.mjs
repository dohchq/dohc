import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOwnedCompilerProcess } from "../src/workspaces/compilerProcessSupervisor.ts";

// Each owner compiles its C# type in a fresh Windows PowerShell process.
// Let cold compiler startup finish once before tests enforce short deadlines.
export async function warmWindowsCompiler() {
  if (process.platform !== "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "dohc-compiler-warmup-"));
  const started = performance.now();
  console.log("Windows compiler warm-up starting (180000 ms bound).");
  try {
    const workerPath = join(directory, "worker.mjs");
    await writeFile(workerPath, "process.stdout.write('warm');");
    const result = await runOwnedCompilerProcess({ nodeExecutable: process.execPath, workerPath }, {
      input: Buffer.alloc(0),
      bounds: { timeoutMs: 180000, maxMemoryBytes: 256 * 1024 * 1024, maxProcesses: 8,
        maxInputBytes: 4096, maxOutputBytes: 4096, maxErrorBytes: 8192 },
    });
    assert.equal(Buffer.from(result.stdout).toString(), "warm");
    console.log(`Windows compiler warm-up completed in ${Math.round(performance.now() - started)} ms.`);
  } catch (error) {
    console.error(`Windows compiler warm-up failed after ${Math.round(performance.now() - started)} ms: ${error.details ?? error.message}`);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
