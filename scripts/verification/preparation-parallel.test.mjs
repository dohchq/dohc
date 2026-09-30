import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPrepareFixture } from "./prepare-fixture.mjs";

for (const scenario of ["success", "engine-failure", "desktop-failure", "late-source-change", "cancel"]) {
  test(`parallel preparation settles both builds before releasing ownership: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), "dohc-prepare-parallel-"));
    try {
      createPrepareFixture(root, new URL("./build.mjs", import.meta.url), { commit: false });
      mkdirSync(join(root, "crates"));
      writeFileSync(join(root, "crates/engine.rs"), "original engine input");
      const adapter = join(root, "scripts/verification/process.mjs");
      writeFileSync(adapter, readFileSync(adapter, "utf8").replace("export async function run(", "async function fixtureRun(") + `
        import {setImmediate} from 'node:timers/promises';
        let engineStarted = false, desktopStarted = false, release;
        const bothStarted = new Promise(resolve => {release = resolve;});
        export const completed = new Set();
        export async function run(command,args,options) {
          const engine = command === 'cargo';
          const desktop = command === 'pnpm' && args[1] === '@dohc/desktop';
          if (!engine && !desktop) return fixtureRun(command,args,options);
          if (engine) engineStarted = true;
          else desktopStarted = true;
          if (engineStarted && desktopStarted) release();
          await bothStarted;
          assert.ok(existsSync(join(repoRoot,'.dohc-dev/verification/build.json.lock')));
          const kind = engine ? 'engine' : 'desktop';
          try {
            if (${JSON.stringify(scenario)} === kind + '-failure') throw Error(kind + ' build rejected');
            if (desktop && ${JSON.stringify(scenario)} === 'late-source-change') {
              while (!readJson(join(repoRoot,'.dohc-dev/verification/build.json'))?.engine) await setImmediate();
              writeFileSync(join(repoRoot,'crates/engine.rs'),'changed after the engine receipt');
            }
            if (desktop && ${JSON.stringify(scenario)} === 'cancel') process.emit('SIGTERM');
            await setImmediate();
            assert.ok(existsSync(join(repoRoot,'.dohc-dev/verification/build.json.lock')), 'Sibling failure released the preparation lock too soon');
            return await fixtureRun(command,args,options);
          } finally { completed.add(kind); }
        }
      `);
      writeFileSync(join(root, "apps/desktop/scripts/require-e2e-engine.mjs"), `
        import assert from 'node:assert/strict';
        import {writeFileSync} from 'node:fs';
        import {completed} from '../../../scripts/verification/process.mjs';
        export function requireE2eEngine() {
          assert.deepEqual([...completed].sort(),['desktop','engine']);
          writeFileSync('.dohc-dev/staged','yes');
        }
      `);
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(root, "no-hooks")}`,
        "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Parallel preparation fixture"], { cwd: root, stdio: "ignore" });
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import cp from 'node:child_process';
        import {existsSync} from 'node:fs';
        import {syncBuiltinESMExports} from 'node:module';
        const exec = cp.execFileSync;
        cp.execFileSync = (command,...args) => command === 'rustc' ? Buffer.from('fixture rustc') : exec(command,...args);
        syncBuiltinESMExports();
        const {prepare} = await import('./scripts/verification/build.mjs');
        const {completed} = await import('./scripts/verification/process.mjs');
        let failure;
        try { await prepare(); } catch (error) {failure = error;}
        assert.deepEqual([...completed].sort(),['desktop','engine']);
        assert.equal(existsSync('.dohc-dev/verification/build.json.lock'),false);
        assert.equal(existsSync('.dohc-dev/staged'),${scenario === "success"});
        if (${JSON.stringify(scenario)} === 'success') assert.equal(failure,undefined);
        else assert.match(failure.message, /build rejected|inputs changed|interrupted/);
      `], { cwd: root, encoding: "utf8", timeout: 20_000 });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, scenario === "cancel" ? 143 : 0, result.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
