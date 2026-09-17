import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "vitest";

// A separate Node process can count the native calls without replacing the
// filesystem backend for other tests in this worker.
describe.skipIf(process.platform !== "win32")("Windows native watch handles", () => {
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
    `, import.meta.resolve("chokidar")], { timeout: 15_000 });
  });

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
        const deadline = Date.now() + 5000;
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
        const errors = [];
        second.on('error', error => errors.push(error));
        const failure = new Error('synthetic native failure');
        native.get(root).watcher.emit('error', failure);
        assert.ok(errors.includes(failure), 'native errors reach the remaining owner');
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
        await third.close();
        assert.equal(native.size, 0);
      } finally {
        await first?.close();
        await second?.close();
        await third?.close();
        await rm(root, { recursive: true, force: true });
      }
    `, import.meta.resolve("chokidar")], { timeout: 15_000 });
  }, 20_000);
});
