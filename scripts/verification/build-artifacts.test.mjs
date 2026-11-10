import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { artifactFingerprint, artifactSourceFingerprint } from "./build.mjs";

const probe = "apps/desktop/resources/agent-probe";
const node = "apps/desktop/resources/app-compiler/node.exe";
const reader = "apps/desktop/resources/engine-reader";

function scratch(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  return { root, write };
}

function artifacts(t) {
  const fixture = scratch(t, "dohc-artifacts-");
  for (const directory of ["apps/desktop/dist", "apps/desktop/resources/cli-bin", "apps/desktop/resources/app-backend-runtime", "services/share-web/viewer/dist", "services/sync-relay/dist"]) {
    mkdirSync(join(fixture.root, directory), { recursive: true });
  }
  fixture.write(node, "node");
  fixture.write(`${reader}/selection.json`, "selection");
  for (const name of ["node", "reader.cjs", "manifest.json"]) fixture.write(`${reader}/generation/${name}`, name);
  for (const name of ["agentProbeOwner.exe", "agentProbeRelay.mjs", "manifest.json"]) fixture.write(`${probe}/${name}`, name);
  return fixture;
}

test("the prepared relay process rejects changed or missing runtime files", t => {
  const { root, write } = artifacts(t);
  write("services/sync-relay/dist/main.js", "relay");
  write("services/sync-relay/dist/liveValidationWorker.js", "worker");
  const fingerprint = () => artifactFingerprint("desktop", root, "linux", "x64");
  const prepared = fingerprint();
  for (const name of ["main.js", "liveValidationWorker.js"]) {
    const path = `services/sync-relay/dist/${name}`;
    write(path, "drift");
    assert.notEqual(fingerprint(), prepared, `${name} changed`);
    rmSync(join(root, path));
    assert.notEqual(fingerprint(), prepared, `${name} deleted`);
    write(path, name === "main.js" ? "relay" : "worker");
    assert.equal(fingerprint(), prepared);
  }
  rmSync(join(root, "services/sync-relay/dist"), { recursive: true });
  assert.throws(fingerprint, { code: "ENOENT" });
});

for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], ["linux", "x64"]]) {
  test(`a ${platform} ${arch} desktop artifact rejects reader drift and missing generations`, t => {
    const { root, write } = artifacts(t);
    const fingerprint = () => artifactFingerprint("desktop", root, platform, arch);
    const prepared = fingerprint();
    for (const path of [`${reader}/selection.json`, ...["node", "reader.cjs", "manifest.json"].map(name => `${reader}/generation/${name}`)]) {
      write(path, "drift");
      assert.notEqual(fingerprint(), prepared, `${path} changed`);
      rmSync(join(root, path));
      assert.notEqual(fingerprint(), prepared, `${path} deleted`);
      write(path, path.endsWith("selection.json") ? "selection" : path.split("/").at(-1));
      assert.equal(fingerprint(), prepared);
    }
    rmSync(join(root, reader), { recursive: true });
    assert.throws(fingerprint, { code: "ENOENT" });
  });
}

test("a Windows x64 desktop artifact rejects a changed, deleted or missing probe closure", t => {
  const { root, write } = artifacts(t);
  const fingerprint = () => artifactFingerprint("desktop", root, "win32", "x64");
  const prepared = fingerprint();
  for (const path of [`${probe}/agentProbeOwner.exe`, `${probe}/agentProbeRelay.mjs`, `${probe}/manifest.json`, node]) {
    write(path, "drift");
    assert.notEqual(fingerprint(), prepared, `${path} changed`);
    rmSync(join(root, path));
    assert.notEqual(fingerprint(), prepared, `${path} deleted`);
    write(path, path === node ? "node" : path.split("/").at(-1));
    assert.equal(fingerprint(), prepared);
  }
  rmSync(join(root, probe), { recursive: true });
  assert.throws(fingerprint, { code: "ENOENT" });
});

for (const [platform, arch] of [["darwin", "arm64"], ["linux", "arm64"], ["linux", "x64"]]) {
  test(`a ${platform} ${arch} desktop artifact reads the compiler tree but not the probe`, t => {
    const { root, write } = artifacts(t);
    rmSync(join(root, probe), { recursive: true });
    const fingerprint = () => artifactFingerprint("desktop", root, platform, arch);
    const prepared = fingerprint();
    write(`apps/desktop/resources/app-compiler/node_modules/@esbuild/${platform}-${arch}/bin/esbuild`, "esbuild");
    assert.notEqual(fingerprint(), prepared);
    rmSync(join(root, dirname(node)), { recursive: true });
    assert.throws(fingerprint, { code: "ENOENT" });
  });
}

test("other targets do not read the probe or compiler trees", t => {
  const { root } = artifacts(t);
  rmSync(join(root, probe), { recursive: true });
  rmSync(join(root, dirname(node)), { recursive: true });
  rmSync(join(root, reader), { recursive: true });
  assert.doesNotThrow(() => artifactFingerprint("desktop", root, "linux", "arm"));
  assert.doesNotThrow(() => artifactFingerprint("desktop", root, "win32", "arm64"));
  assert.doesNotThrow(() => artifactFingerprint("desktop", root, "darwin", "x64"));
});

test("Linux arm64 does not require a desktop reader", t => {
  const { root } = artifacts(t);
  rmSync(join(root, reader), { recursive: true });
  assert.doesNotThrow(() => artifactFingerprint("desktop", root, "linux", "arm64"));
});

test("desktop production inputs cover the probe sources and ignore staged probe output", t => {
  const { root, write } = scratch(t, "dohc-probe-sources-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  write("apps/desktop/package.json", JSON.stringify({ name: "@dohc/desktop", scripts: { build: "node scripts/stage-agent-probe.mjs" } }));
  write("apps/desktop/.gitignore", readFileSync(new URL("../../apps/desktop/.gitignore", import.meta.url), "utf8"));
  const sources = ["apps/desktop/src/agents/agentProbeOwner.cs", "apps/desktop/src/agents/agentProbeRelay.mjs", "apps/desktop/scripts/stage-agent-probe.mjs"];
  for (const path of sources) write(path, path);
  const prepared = artifactSourceFingerprint("desktop", root);
  write(`${probe}/agentProbeOwner.exe`, "staged");
  write(`${probe}.staging-abc123/agentProbeOwner.exe`, "staging");
  assert.equal(artifactSourceFingerprint("desktop", root), prepared, "staged probe output is not a source");
  for (const path of sources) {
    write(path, "drift");
    assert.notEqual(artifactSourceFingerprint("desktop", root), prepared, `${path} changed`);
    rmSync(join(root, path));
    assert.notEqual(artifactSourceFingerprint("desktop", root), prepared, `${path} deleted`);
    write(path, path);
  }
  assert.equal(artifactSourceFingerprint("desktop", root), prepared);
});
