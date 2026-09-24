import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "vitest";

// A separate Node process can count the native calls without replacing the
// filesystem backend for other tests in this worker. Each wait sits inside the
// next (20 s in the child, 40 s for the child, 60 s for the test) so a loaded
// gate host reports the condition that stalled rather than an outer timeout.
describe.skipIf(process.platform !== "win32")("Windows native watch handles", () => {
  it("coalesces uncertain bursts and reruns when a later deletion arrives during the first sweep", async () => {
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", String.raw`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import fsp from 'node:fs/promises';
      import { EventEmitter } from 'node:events';
      import { syncBuiltinESMExports } from 'node:module';
      import { join, resolve } from 'node:path';
      import { tmpdir } from 'node:os';
      const root = await fsp.mkdtemp(join(tmpdir(), 'dohc-watch-burst-'));
      const target = join(root, 'later-delete.md');
      const sibling = join(root, 'unchanged.md');
      await fsp.writeFile(target, 'before');
      await fsp.writeFile(sibling, 'before');
      const realStat = fsp.stat;
      const snapshots = new Map([[target, await realStat(target)], [sibling, await realStat(sibling)]]);
      const pending = [];
      const native = new Map();
      let controlled = false;
      fs.watch = (path, options, listener) => {
        const emitter = new EventEmitter();
        emitter.close = () => native.delete(resolve(path));
        native.set(resolve(path), listener);
        return emitter;
      };
      fsp.stat = async (path, ...args) => controlled && snapshots.has(resolve(path))
        ? new Promise((resolveStat, reject) => pending.push({ path: resolve(path), resolve: resolveStat, reject }))
        : realStat(path, ...args);
      syncBuiltinESMExports();
      const { watch } = await import(process.argv[1]);
      const watcher = watch(root, { ignoreInitial: true });
      const waitFor = async predicate => {
        const deadline = Date.now() + 20_000;
        while (!predicate()) {
          assert.ok(Date.now() < deadline, 'sweep did not settle');
          await new Promise(resolve => setImmediate(resolve));
        }
      };
      try {
        await new Promise((resolve, reject) => watcher.once('ready', resolve).once('error', reject));
        controlled = true;
        const emit = native.get(root);
        for (let i = 0; i < 20; i++) emit('rename', 'UNREL~1.MD');
        await Promise.resolve(); await Promise.resolve();
        assert.equal(pending.length, 2, 'a burst starts one stat per file, not one per event');
        const deleted = new Promise(resolve => watcher.once('unlink', resolve));
        // The first stat snapshots preceded this notification. A trailing
        // sweep must observe the deletion even though the first results do not.
        await fsp.rm(target);
        emit('rename', 'LATER~1.MD');
        for (const request of pending.slice(0, 2)) request.resolve(snapshots.get(request.path));
        await waitFor(() => pending.length >= 4);
        assert.equal(pending.length, 4, 'one trailing sweep covers notifications received in flight');
        for (const request of pending.slice(2)) {
          if (request.path === target) request.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }));
          else request.resolve(snapshots.get(request.path));
        }
        assert.equal(await deleted, target);
      } finally {
        controlled = false;
        for (const request of pending) request.resolve(snapshots.get(request.path));
        await watcher.close();
        await fsp.rm(root, { recursive: true, force: true });
      }
    `, import.meta.resolve("chokidar")], { timeout: 40_000 });
  }, 60_000);

  it("resolves short-name content changes without relying on changed file metadata", async () => {
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", String.raw`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import fsp from 'node:fs/promises';
      import { EventEmitter } from 'node:events';
      import { syncBuiltinESMExports } from 'node:module';
      import { join, resolve } from 'node:path';
      import { tmpdir } from 'node:os';
      const root = await fsp.mkdtemp(join(tmpdir(), 'dohc-watch-short-change-'));
      const target = join(root, 'changed-file.md');
      const sibling = join(root, 'unchanged-file.md');
      await fsp.writeFile(target, 'before');
      await fsp.writeFile(sibling, 'before');
      const originalStat = fsp.stat;
      const originalRealpath = fsp.realpath;
      const snapshots = new Map([[target, await originalStat(target)], [sibling, await originalStat(sibling)]]);
      const native = new Map();
      fs.watch = (path, options, listener) => {
        const emitter = new EventEmitter();
        emitter.close = () => native.delete(resolve(path));
        native.set(resolve(path), listener);
        return emitter;
      };
      // Model an actual content notification on a filesystem whose stat
      // snapshot did not change. The notification must remain authoritative.
      fsp.stat = async (path, ...args) => snapshots.get(resolve(path)) ?? originalStat(path, ...args);
      fsp.realpath = async (path, ...args) => resolve(path) === join(root, 'CHANGE~1.MD')
        ? target : originalRealpath(path, ...args);
      syncBuiltinESMExports();
      const { watch } = await import(process.argv[1]);
      const watcher = watch(root, { ignoreInitial: true });
      try {
        await new Promise((resolve, reject) => watcher.once('ready', resolve).once('error', reject));
        await fsp.writeFile(target, 'after!');
        const changes = [];
        let observed;
        const done = new Promise(resolve => { observed = resolve; });
        watcher.on('change', path => { changes.push(path); observed(); });
        native.get(root)('change', 'CHANGE~1.MD');
        await done;
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(changes, [target], 'the target emits despite identical stats; its sibling does not');
      } finally {
        await watcher.close();
        await fsp.rm(root, { recursive: true, force: true });
      }
    `, import.meta.resolve("chokidar")], { timeout: 40_000 });
  }, 60_000);

  it("creates a fresh shared handle after a native error and preserves it when stale owners close", async () => {
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", String.raw`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { mkdtemp, writeFile, rm } from 'node:fs/promises';
      import { EventEmitter } from 'node:events';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      import { tmpdir } from 'node:os';
      const root = await mkdtemp(join(tmpdir(), 'dohc-watch-recovery-'));
      for (const name of ['old.md', 'new.md', 'third.md']) await writeFile(join(root, name), 'value');
      const native = [];
      fs.watch = (path, options, listener) => {
        const emitter = new EventEmitter();
        const entry = { emitter, listener, closed: false };
        emitter.close = () => { entry.closed = true; };
        native.push(entry);
        return emitter;
      };
      syncBuiltinESMExports();
      const { watch } = await import(process.argv[1]);
      const watchers = [];
      const start = async name => {
        const watcher = watch(join(root, name), { ignoreInitial: true });
        watchers.push(watcher);
        await new Promise((resolve, reject) => watcher.once('ready', resolve).once('error', reject));
        return watcher;
      };
      try {
        const first = await start('old.md');
        first.on('error', () => {});
        // Node closes its native handle before delivering this error.
        native[0].emitter.close();
        native[0].emitter.emit('error', new Error('native watch failed'));
        await start('new.md');
        assert.equal(native.length, 2, 'new registrations cannot join a failed handle');
        await first.close();
        const third = await start('third.md');
        assert.equal(native.length, 2, 'stale close cannot evict the replacement handle');
        const observed = new Promise(resolve => third.once('change', resolve));
        native[1].listener('change', 'third.md');
        assert.equal(await observed, join(root, 'third.md'));
      } finally {
        for (const watcher of watchers) await watcher.close();
        assert.ok(native.every(entry => entry.closed));
        await rm(root, { recursive: true, force: true });
      }
    `, import.meta.resolve("chokidar")], { timeout: 40_000 });
  }, 60_000);

  it("does not let an unrelated short-name hint suppress a real edit", async () => {
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", String.raw`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import fsp from 'node:fs/promises';
      import { EventEmitter } from 'node:events';
      import { syncBuiltinESMExports } from 'node:module';
      import { join, resolve } from 'node:path';
      import { tmpdir } from 'node:os';
      const root = await fsp.mkdtemp(join(tmpdir(), 'dohc-watch-throttle-'));
      const target = join(root, 'sibling.md');
      await fsp.writeFile(target, 'before');
      const native = new Map();
      const realStat = fsp.stat;
      let controlled = false, edited = false, before, statCalls = 0;
      fs.watch = (path, options, listener) => {
        const emitter = new EventEmitter();
        emitter.close = () => native.delete(resolve(path));
        native.set(resolve(path), listener);
        return emitter;
      };
      fsp.stat = async (path, ...args) => {
        if (controlled && resolve(path) === target) {
          statCalls++;
          return edited ? { ...before, size: before.size + 10, mtimeMs: before.mtimeMs + 1000 } : before;
        }
        return realStat(path, ...args);
      };
      syncBuiltinESMExports();
      const { watch } = await import(process.argv[1]);
      const watcher = watch(target, { ignoreInitial: true });
      try {
        await new Promise((resolve, reject) => watcher.once('ready', resolve).once('error', reject));
        before = await realStat(target);
        controlled = true;
        const changes = [];
        watcher.on('change', path => changes.push(path));
        const emit = native.get(root);
        emit('rename', 'UNREL~1.MD');
        await Promise.resolve(); await Promise.resolve();
        assert.equal(statCalls, 1, 'uncertain hint rechecked the unchanged file');
        assert.deepEqual(changes, []);
        edited = true;
        emit('change', 'sibling.md');
        await Promise.resolve(); await Promise.resolve();
        assert.equal(statCalls, 2, 'the real edit is not throttled by the unrelated hint');
        assert.equal(changes.length, 1, 'the real edit remains visible');
      } finally {
        await watcher.close();
        await fsp.rm(root, { recursive: true, force: true });
      }
    `, import.meta.resolve("chokidar")], { timeout: 40_000 });
  }, 60_000);

  it("shares directory handles, routes ambiguous names, and closes each owner", async () => {
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", String.raw`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join, resolve } from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';

      const root = await mkdtemp(join(tmpdir(), 'dohc-watch-handles-'));
      const native = new Map();
      let suppressNative = false;
      const originalWatch = fs.watch;
      fs.watch = (path, options, listener) => {
        const watcher = originalWatch(path, options, (...args) => {
          if (!suppressNative) listener(...args);
        });
        const key = resolve(path);
        assert.ok(!native.has(key), 'one native watcher per directory');
        native.set(key, { watcher, listener });
        const close = watcher.close.bind(watcher);
        watcher.close = () => { native.delete(key); return close(); };
        return watcher;
      };
      syncBuiltinESMExports();
      const { watch } = await import(process.argv[1]);
      const waitFor = async (predicate) => {
        const deadline = Date.now() + 20_000;
        while (!predicate()) {
          assert.ok(Date.now() < deadline, 'watch event timed out');
          await new Promise(resolve => setImmediate(resolve));
        }
      };
      let first, second, third;
      try {
        await mkdir(join(root, 'nested'));
        await writeFile(join(root, 'long-filename.md'), 'first');
        await writeFile(join(root, 'other.md'), 'second');
        await writeFile(join(root, 'nested', 'child.md'), 'third');
        first = watch(root, { ignoreInitial: true, followSymlinks: false });
        await new Promise((resolve, reject) => first.once('ready', resolve).once('error', reject));
        assert.equal(native.size, 2, 'file count must not grow native handle count');

        second = watch(join(root, 'long-filename.md'), { ignoreInitial: true });
        await new Promise((resolve, reject) => second.once('ready', resolve).once('error', reject));
        assert.equal(native.size, 2, 'direct file watch shares its parent handle');
        const changes = [];
        second.on('change', path => changes.push(path));
        await first.close();
        assert.equal(native.size, 1, 'closing a tree preserves another file owner');
        await writeFile(join(root, 'long-filename.md'), 'after first owner closes');
        await waitFor(() => changes.includes(join(root, 'long-filename.md')));

        // Missing and 8.3 filenames are legal native notifications. Dispatch
        // them directly, while the actual stat and Chokidar handlers still run.
        changes.length = 0;
        let raw = 0;
        second.on('raw', () => raw++);
        native.get(root).listener('change', 'other.md');
        assert.equal(raw, 0, 'a normal sibling event does not reach this file');
        native.get(root).listener('rename', 'LONG-F~1.MD');
        assert.ok(raw > 0, 'ambiguous short name reaches the long-name owner');
        const before = raw;
        native.get(root).listener('change', null);
        assert.ok(raw > before, 'missing filename reaches the file owner');
        const unlinks = [];
        second.on('unlink', path => unlinks.push(path));
        suppressNative = true;
        await rm(join(root, 'long-filename.md'));
        native.get(root).listener('rename', 'LONG-F~1.MD');
        await waitFor(() => unlinks.includes(join(root, 'long-filename.md')));
        await second.close();
        assert.equal(native.size, 0, 'last owner closes the native handle');

        // A short-name delete invalidates its owner without notifying every
        // unchanged sibling. This also exercises reuse after the last close.
        await writeFile(join(root, 'long-filename.md'), 'recreated');
        third = watch(root, { ignoreInitial: true, followSymlinks: false });
        await new Promise((resolve, reject) => third.once('ready', resolve).once('error', reject));
        const falseChanges = [];
        const deleted = [];
        third.on('change', path => falseChanges.push(path));
        third.on('unlink', path => deleted.push(path));
        await rm(join(root, 'long-filename.md'));
        native.get(root).listener('rename', 'LONG-F~1.MD');
        await waitFor(() => deleted.includes(join(root, 'long-filename.md')));
        assert.deepEqual(falseChanges, [], 'unchanged siblings are not file changes');
        const errors = [];
        third.on('error', error => errors.push(error));
        const failure = new Error('synthetic native failure');
        const failedNative = native.get(root).watcher;
        failedNative.close();
        failedNative.emit('error', failure);
        assert.ok(errors.includes(failure), 'native errors reach the remaining owner');
        await third.close();
        assert.equal(native.size, 0);
      } finally {
        await first?.close();
        await second?.close();
        await third?.close();
        await rm(root, { recursive: true, force: true });
      }
    `, import.meta.resolve("chokidar")], { timeout: 40_000 });
  }, 60_000);
});
