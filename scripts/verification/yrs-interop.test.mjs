import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPrepareFixture } from "./prepare-fixture.mjs";
import { interopArtifact } from "./yrs-interop.mjs";

test("interop preparation selects Cargo's exact production executable", () => {
  const root = join(tmpdir(), "interop-artifact");
  const artifact = { reason: "compiler-artifact", target: { name: "dohc-yrs-interop", kind: ["bin"] },
    profile: { test: false }, manifest_path: join(root, "crates/yrs-interop/Cargo.toml"), executable: join(root, "target/debug/exact-peer") };
  assert.equal(interopArtifact([{ ...artifact, profile: { test: true } }, artifact], root), artifact.executable);
  const alternateCase = { ...artifact, manifest_path: artifact.manifest_path.toUpperCase(), executable: artifact.executable.toUpperCase() };
  if (process.platform === "win32") assert.equal(interopArtifact([alternateCase], root), alternateCase.executable);
  else assert.throws(() => interopArtifact([alternateCase], root), /did not report/);
  for (const mutation of [{ profile: { test: true } }, { target: { name: "other", kind: ["bin"] } },
    { manifest_path: join(root, "other/Cargo.toml") }, { executable: join(root, "target-other/debug/peer") }]) {
    assert.throws(() => interopArtifact([{ ...artifact, ...mutation }], root), /did not report/);
  }
});

test("interop preparation owns targets, refuses stale provenance, and drivers never build", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-interop-"));
  const put = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  try {
    createPrepareFixture(root, new URL("./build.mjs", import.meta.url));
    put("scripts/verification/yrs-interop.mjs", readFileSync(new URL("./yrs-interop.mjs", import.meta.url)));
    put("crates/yrs-interop/scripts/rustPeer.ts", readFileSync(new URL("../../crates/yrs-interop/scripts/rustPeer.ts", import.meta.url)));
    put("vendor/fixture/lib.rs", "original vendor input");
    put("scripts/verification/process.mjs", readFileSync(join(root, "scripts/verification/process.mjs"), "utf8")
      .replace("export async function run(", "async function originalRun(") + `
      export let builds = 0;
      export async function run(command,args,{env}) {
        assert.equal(command,'cargo');
        assert.deepEqual(args,['build','--locked','--target-dir',join(repoRoot,'target'),'-p','dohc-yrs-interop',
          '--bin','dohc-yrs-interop','--message-format=json-render-diagnostics']);
        for(const name of ['CARGO_TARGET_DIR','CARGO_BUILD_TARGET_DIR','CARGO_BUILD_BUILD_DIR']) assert.equal(env[name],join(repoRoot,'target'));
        builds++;
        const executable=join(repoRoot,'target/debug/exact-peer');
        mkdirSync(dirname(executable),{recursive:true});writeFileSync(executable,process.env.FIXTURE_BYTES ?? 'peer bytes');chmodSync(executable,0o755);
        if(process.env.FIXTURE_FAULT==='source')writeFileSync(join(repoRoot,'vendor/fixture/lib.rs'),'changed during build');
        if(process.env.FIXTURE_FAULT==='cancel')process.emit('SIGTERM');
        return {stdout:JSON.stringify({reason:'compiler-artifact',target:{name:'dohc-yrs-interop',kind:['bin']},
          profile:{test:false},manifest_path:join(repoRoot,'crates/yrs-interop/Cargo.toml'),executable})};
      }
    `);
    const script = `
      import assert from 'node:assert/strict';
      import cp from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      import {EventEmitter} from 'node:events';
      import {PassThrough} from 'node:stream';
      import {closeSync,existsSync,mkdirSync,openSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
      const exec=cp.execFileSync;
      cp.execFileSync=(command,...args)=>command==='rustc'?Buffer.from('fixture rustc'):exec(command,...args);
      cp.spawnSync=()=>{throw Error('drivers must not build');};
      const launched=[];
      cp.spawn=(binary,args,options)=>{
        launched.push(binary);
        const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();
        child.kill=()=>{child.stdout.end();child.emit('exit',0,null);};return child;
      };
      syncBuiltinESMExports();
      const {prepareInterop,assertInteropPrepared}=await import('./scripts/verification/yrs-interop.mjs');
      const commands=await import('./scripts/verification/process.mjs');
      const {RustPeer}=await import('./crates/yrs-interop/scripts/rustPeer.ts');
      const receiptPath='.dohc-dev/verification/yrs-interop.json';
      assert.throws(()=>new RustPeer(),/missing or differs/);
      assert.equal(launched.length,0);
      mkdirSync('.dohc-dev/verification',{recursive:true});
      const owner=JSON.stringify({pid:process.pid,startedAt:'fixture'});
      writeFileSync(receiptPath+'.lock',owner);
      await assert.rejects(prepareInterop(),/Another preparation owns.*Inspect its PID/);
      assert.equal(readFileSync(receiptPath+'.lock','utf8'),owner);
      rmSync(receiptPath+'.lock');
      const first=await prepareInterop();
      assert.deepEqual(await prepareInterop(),first);
      assert.equal(commands.builds,1);
      assert.equal(assertInteropPrepared().artifact,first.artifact);
      const receiptBytes=readFileSync(receiptPath,'utf8');
      const alternateReceipt={...first,path:first.path.toUpperCase()};
      writeFileSync(receiptPath,JSON.stringify(alternateReceipt));
      if(process.platform==='win32') {
        assert.equal(assertInteropPrepared().path,alternateReceipt.path);
        assert.deepEqual(await prepareInterop(),alternateReceipt);
      } else assert.throws(()=>assertInteropPrepared(),/missing or differs/);
      writeFileSync(receiptPath,receiptBytes);
      writeFileSync(first.path,'tampered executable');
      assert.throws(()=>new RustPeer(),/missing or differs/);
      assert.equal(launched.length,0);
      await prepareInterop();
      writeFileSync('vendor/fixture/lib.rs','vendor edit');
      assert.throws(()=>new RustPeer(),/missing or differs/);
      let original=openSync(first.path,'r');
      let replacementRetries=0;
      try {
        process.env.FIXTURE_BYTES='replacement peer bytes';
        let replacement;
        try {replacement=await prepareInterop();}
        catch(error) {
          assert.equal(process.platform,'win32');
          assert.ok(['EPERM','EACCES'].includes(error.code));
          assert.equal(readFileSync(first.path,'utf8'),'peer bytes');
          assert.equal(existsSync(first.path+'.tmp'),false);
          closeSync(original);original=undefined;
          replacementRetries++;
          replacement=await prepareInterop();
        }
        assert.equal(replacement.path,first.path);
        assert.notEqual(replacement.artifact,first.artifact);
        assert.equal(assertInteropPrepared().artifact,replacement.artifact);
        assert.equal(readFileSync(first.path,'utf8'),'replacement peer bytes');
        if(original!==undefined)assert.equal(readFileSync(original,'utf8'),'peer bytes');
      } finally {if(original!==undefined)closeSync(original);}
      new RustPeer().close();
      new RustPeer().close();
      assert.deepEqual(launched,[first.path,first.path]);
      assert.equal(commands.builds,3+replacementRetries);
      writeFileSync(first.path,'changed after the first peer');
      assert.throws(()=>new RustPeer(),/changed during this driver run/);
      assert.equal(launched.length,2);
      for(const fault of ['source','cancel']) {
        rmSync(receiptPath,{force:true});process.env.FIXTURE_FAULT=fault;
        const listeners=['SIGINT','SIGTERM'].map(signal=>process.listenerCount(signal));
        const previousBytes=readFileSync(first.path,'utf8');
        await assert.rejects(prepareInterop(),fault==='source'?/inputs changed/:/interrupted by SIGTERM/);
        assert.equal(readFileSync(first.path,'utf8'),previousBytes);
        assert.equal(existsSync(receiptPath),false);
        assert.equal(existsSync(first.path+'.tmp'),false);
        assert.equal(existsSync(receiptPath+'.tmp'),false);
        assert.equal(existsSync(receiptPath+'.lock'),false);
        assert.deepEqual(['SIGINT','SIGTERM'].map(signal=>process.listenerCount(signal)),listeners);
      }
      process.exitCode=0;
    `;
    for (const target of [undefined, "relative-custom-target"]) {
      rmSync(join(root, ".dohc-dev/verification/yrs-interop.json"), { force: true });
      put("vendor/fixture/lib.rs", "original vendor input");
      const env = { ...process.env };
      delete env.CARGO_TARGET_DIR;
      if (target) env.CARGO_TARGET_DIR = target;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: root, encoding: "utf8", timeout: 30_000, env,
      });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, 0, result.stderr);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("harvest extracts current engine blobs and keeps the previous corpus on failure", () => {
  const root = mkdtempSync(join(tmpdir(), "dohc-harvest-"));
  const script = join(root, "crates/yrs-interop/scripts/harvest.mjs");
  const fixtures = join(root, "crates/yrs-interop/fixtures");
  const source = join(root, "copy/engine.db");
  const harvest = path => spawnSync(process.execPath, [script, path], { cwd: root, encoding: "utf8", timeout: 30_000 });
  const put = (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  // The engine's own table definitions, so a renamed column fails here.
  const migration = readFileSync(new URL("../../crates/dohc-engine-storage/src/migration.rs", import.meta.url), "utf8");
  const write = change => {
    const db = new DatabaseSync(source, { enableForeignKeyConstraints: false });
    try { change(db); } finally { db.close(); }
  };
  const blob = (db, ...bytes) => {
    const value = Uint8Array.from(bytes);
    const sha = createHash("sha256").update(value).digest("hex");
    db.prepare("INSERT OR IGNORE INTO binary_blobs (sha256, byte_length, bytes) VALUES (?, ?, ?)").run(sha, value.length, value);
    return sha;
  };
  const doc = (db, object, kind) => db.prepare(`INSERT INTO ydoc_docs (workspace_id, version_id, object_id, content_kind, updated_at_ms)
    VALUES ('ws', 'main', ?, ?, 0)`).run(object, kind);
  const update = (db, object, seq, sha) => db.prepare(`INSERT INTO ydoc_updates (workspace_id, version_id, object_id, seq, update_blob_sha256, recorded_at_ms)
    VALUES ('ws', 'main', ?, ?, ?, 0)`).run(object, seq, sha);
  const snapshot = (db, object, seq, sha) => db.prepare(`INSERT INTO ydoc_snapshots
    (workspace_id, version_id, object_id, up_to_seq, snapshot_blob_sha256, state_vector_blob_sha256, recorded_at_ms)
    VALUES ('ws', 'main', ?, ?, ?, ?, 0)`).run(object, seq, sha, sha);
  try {
    put(script, readFileSync(new URL("../../crates/yrs-interop/scripts/harvest.mjs", import.meta.url)));
    put(join(fixtures, "harvested/previous.bin"), "previous corpus");
    put(join(root, "workspace/.dohc/engine/engine.db"), "");
    put(join(root, "copy/garbage.db"), "not a database");
    mkdirSync(dirname(source), { recursive: true });
    write(db => {
      for (const table of ["binary_blobs", "ydoc_docs", "ydoc_updates", "ydoc_snapshots"]) {
        db.exec(migration.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\) STRICT;`))[0]);
      }
      doc(db, "a", "richdoc");
      snapshot(db, "a", 3, blob(db, 0xa3, 0x00, 0xff));
      snapshot(db, "a", 1, blob(db, 0xa1));
      for (let seq = 1; seq <= 5; seq++) update(db, "a", seq, blob(db, seq, 0x00, 0xff));
      doc(db, "b", "plaintext");
      for (let seq = 1; seq <= 2; seq++) update(db, "b", seq, blob(db, 0xb0 + seq));
      doc(db, "c", "richdoc");
      update(db, "c", 1, "0".repeat(64));
    });

    for (const [path, error] of [[join(root, "workspace/.dohc/engine/engine.db"), /refusing/],
      [join(root, "copy/garbage.db"), /harvest failed/], [source, /missing blob 0{64}/]]) {
      const result = harvest(path);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, error);
      assert.deepEqual(readdirSync(fixtures), ["harvested"]);
      assert.deepEqual(readdirSync(join(fixtures, "harvested")), ["previous.bin"]);
      assert.equal(readFileSync(join(fixtures, "harvested/previous.bin"), "utf8"), "previous corpus");
    }

    write(db => {
      db.exec("DELETE FROM ydoc_updates WHERE object_id = 'c'; DELETE FROM ydoc_docs WHERE object_id = 'c'");
    });
    const result = harvest(source);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(fixtures), ["harvested"]);
    const harvested = join(fixtures, "harvested");
    assert.deepEqual(readdirSync(harvested), ["doc-01", "doc-02", "manifest.json"]);
    assert.deepEqual(JSON.parse(readFileSync(join(harvested, "manifest.json"), "utf8")), [
      { name: "doc-01", contentKind: "richdoc", files: ["snapshot.bin", "update-0004.bin", "update-0005.bin"] },
      { name: "doc-02", contentKind: "plaintext", files: ["update-0001.bin", "update-0002.bin"] },
    ]);
    for (const [file, bytes] of [["doc-01/snapshot.bin", [0xa3, 0x00, 0xff]], ["doc-01/update-0004.bin", [4, 0x00, 0xff]],
      ["doc-01/update-0005.bin", [5, 0x00, 0xff]], ["doc-02/update-0001.bin", [0xb1]], ["doc-02/update-0002.bin", [0xb2]]]) {
      assert.deepEqual([...readFileSync(join(harvested, file))], bytes, file);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
