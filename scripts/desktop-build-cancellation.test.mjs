import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function stopRecordedChild(path) {
  if (!existsSync(path)) return;
  const { pid } = JSON.parse(readFileSync(path, "utf8"));
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const stopped = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 5000, windowsHide: true });
    if (stopped.status === 0) return;
  }
  try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

async function runLauncher(source, args, env, outcome) {
  const launcher = spawn(process.execPath, ["--input-type=module", "-e", source, ...args], {
    env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let error;
  let signaled = false;
  const timer = setTimeout(() => {
    error = new Error("Desktop Cargo fixture timed out after 20000ms");
    launcher.kill("SIGKILL");
  }, 20_000);
  launcher.stdout.on("data", (chunk) => {
    stdout += String(chunk);
    if (process.platform !== "win32" && outcome !== "success" && !signaled && /(?:^|\n)fixture-cargo-ready\r?\n/.test(stdout)) {
      signaled = true;
      launcher.kill(outcome);
    }
  });
  launcher.stderr.on("data", (chunk) => { stderr += String(chunk); });
  try {
    return await new Promise((resolve) => {
      launcher.once("error", (failure) => { error = failure; });
      launcher.once("close", (status, signal) => resolve({ status, signal, error, stdout, stderr }));
    });
  } finally { clearTimeout(timer); }
}

for (const flow of ["dev", "release"]) {
  for (const [outcome, expectedStatus] of [["success", 0], ["SIGINT", 130], ["SIGTERM", 143]]) {
    test(`desktop ${flow} Cargo ${outcome} completes cleanup before continuing`, async () => {
      const root = mkdtempSync(join(tmpdir(), "dohc-desktop-cargo-"));
      let childStopped = false;
      try {
        const result = await runLauncher(`
          import assert from "node:assert/strict";
          import { existsSync, mkdirSync, writeFileSync } from "node:fs";
          import { join } from "node:path";
          import { buildThenStartDesktop, foregroundExitCode } from ${JSON.stringify(new URL("../apps/desktop/scripts/dev.mjs", import.meta.url).href)};
          import { buildWorkspaceEngine } from ${JSON.stringify(new URL("../apps/desktop/scripts/build-workspace-engine.mjs", import.meta.url).href)};
          import { withBuildBudget } from ${JSON.stringify(new URL("verification/build.mjs", import.meta.url).href)};
          import { run } from ${JSON.stringify(new URL("verification/process.mjs", import.meta.url).href)};
          const [root, flow, outcome] = process.argv.slice(1);
          const slot = join(root, "slots", "build-slot-1");
          const binaryName = "dohc-workspace-engine" + (process.platform === "win32" ? ".exe" : "");
          const stagedDirectory = join(root, "desktop", "resources", "workspace-engine");
          const stagedBinary = join(stagedDirectory, binaryName);
          if (flow === "release") {
            mkdirSync(join(root, "target", "release"), { recursive: true });
            writeFileSync(join(root, "target", "release", binaryName), "cached engine");
            mkdirSync(stagedDirectory, { recursive: true });
            writeFileSync(stagedBinary, "stale staged engine");
          }
          let child;
          let interrupted = false;
          let heldAfterSignal = false;
          const runCargo = (command, args, options) => {
            assert.equal(command, "cargo");
            const output = flow === "dev" ? JSON.stringify({
              reason: "compiler-artifact", target: { name: "dohc-workspace-engine", kind: ["bin"] },
              executable: join(args[args.indexOf("--target-dir") + 1], "debug", binaryName),
            }) : "release build completed";
            const source = outcome === "success" ? "console.log(" + JSON.stringify(output) + ");"
              : "setInterval(() => {}, 1000); console.log('cargo-ready');";
            return run(process.execPath, ["-e", source], {
              ...options,
              onSpawn: spawned => {
                child = spawned;
                writeFileSync(join(root, "child.json"), JSON.stringify({ pid: child.pid }));
                if (outcome === "success") return;
                let output = "";
                child.stdout.on("data", function ready(chunk) {
                  output += String(chunk);
                  if (!output.includes("cargo-ready")) return;
                  child.stdout.off("data", ready);
                  assert.equal(existsSync(slot), true);
                  if (process.platform === "win32") {
                    process.emit(outcome);
                    heldAfterSignal = existsSync(slot);
                  } else {
                    process.once(outcome, () => { heldAfterSignal = existsSync(slot); });
                    console.log("fixture-cargo-ready");
                  }
                });
              },
            });
          };
          try {
            if (flow === "dev") {
              const server = await buildThenStartDesktop({ runCargo, startDev: () => {
                assert.equal(existsSync(slot), false);
                writeFileSync(join(root, "dev-started"), "started");
                return { status: 0, signal: null };
              } });
              assert.equal(foregroundExitCode(server), 0);
            } else {
              await withBuildBudget(env => buildWorkspaceEngine({ repoRoot: root, desktopDir: join(root, "desktop"), env, runCargo }));
            }
          } catch (error) {
            assert.notEqual(outcome, "success");
            assert.match(error.message, /interrupted/);
            interrupted = true;
          } finally {
            writeFileSync(join(root, "result.json"), JSON.stringify({
              interrupted, heldAfterSignal, slotExists: existsSync(slot),
              devStarted: existsSync(join(root, "dev-started")), staged: existsSync(stagedBinary),
              childStopped: Boolean(child && (child.exitCode !== null || child.signalCode !== null)),
            }));
          }
        `, [root, flow, outcome], {
          ...process.env, DOHC_BUILD_SLOT_ROOT: join(root, "slots"), DOHC_GATE_DISK_FLOOR_GB: "0",
        }, outcome);
        const receiptPath = join(root, "result.json");
        const receipt = existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : null;
        childStopped = receipt?.childStopped === true;
        assert.equal(result.error, undefined);
        assert.equal(result.status, expectedStatus, result.stderr);
        assert.deepEqual(receipt, {
          interrupted: outcome !== "success", heldAfterSignal: outcome !== "success", slotExists: false,
          devStarted: flow === "dev" && outcome === "success", staged: flow === "release" && outcome === "success",
          childStopped: true,
        });
        if (receipt.staged) {
          const binaryName = `dohc-workspace-engine${process.platform === "win32" ? ".exe" : ""}`;
          assert.equal(readFileSync(join(root, "desktop/resources/workspace-engine", binaryName), "utf8"), "cached engine");
        }
      } finally {
        if (!childStopped) stopRecordedChild(join(root, "child.json"));
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`desktop dev ${signal} after Cargo closes prevents server startup (${process.platform === "win32" ? "synthetic Windows event" : "real POSIX signal"})`, () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-desktop-handoff-"));
    try {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import {execFileSync} from 'node:child_process';
        import {existsSync,writeFileSync} from 'node:fs';
        import {join} from 'node:path';
        import {buildThenStartDesktop} from ${JSON.stringify(new URL("../apps/desktop/scripts/dev.mjs", import.meta.url).href)};
        import {run} from ${JSON.stringify(new URL("verification/process.mjs", import.meta.url).href)};
        const root=process.argv[1];
        const slot=join(root,'slots/build-slot-1');
        let child;
        let childClosedAtSignal=false;
        let slotHeldAtSignal=false;
        let interrupted=false;
        let devStarted=false;
        try {
          await buildThenStartDesktop({
            runCargo:async(command,args,options)=>{
              assert.equal(command,'cargo');
              // Only the external compiler is replaced. The actual run() owns
              // and closes a real subprocess before the native boundary signal.
              const artifact={reason:'compiler-artifact',target:{name:'dohc-workspace-engine',kind:['bin']},
                executable:join(args[args.indexOf('--target-dir')+1],'debug','dohc-workspace-engine'+(process.platform==='win32'?'.exe':''))};
              const built=await run(process.execPath,['-e','console.log('+JSON.stringify(JSON.stringify(artifact))+')'],{
                ...options,onSpawn:owned=>{child=owned;},
              });
              childClosedAtSignal=child.exitCode!==null||child.signalCode!==null;
              slotHeldAtSignal=existsSync(slot);
              if(process.platform==='win32')process.emit('${signal}');
              else execFileSync(process.execPath,['-e',"process.kill("+process.pid+",'${signal}')"]);
              return built;
            },
            startDev:()=>{devStarted=true;return {status:0,signal:null};},
          });
        }catch(error){assert.match(error.message,/interrupted/);interrupted=true;}
        writeFileSync(join(root,'result.json'),JSON.stringify({interrupted,devStarted,childClosedAtSignal,slotHeldAtSignal,
          slotExists:existsSync(slot),listeners:[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')]}));
      `, root], { encoding: "utf8", timeout: 10_000, windowsHide: true,
        env: { ...process.env, DOHC_BUILD_SLOT_ROOT: join(root, "slots"), DOHC_GATE_DISK_FLOOR_GB: "0" } });
      assert.equal(result.error, undefined, result.stderr);
      const outcome = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
      assert.deepEqual(outcome, { interrupted: true, devStarted: false, childClosedAtSignal: true, slotHeldAtSignal: true,
        slotExists: false, listeners: [0, 0] }, JSON.stringify({ status: result.status, signal: result.signal, outcome }));
      assert.equal(result.status, signal === "SIGINT" ? 130 : 143, result.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
