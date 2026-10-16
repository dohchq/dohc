import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withSystemClipboardLock } from "../apps/desktop/e2e/helpers/systemClipboardLock.mjs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

const childEntry = new URL("./fixtures/system-clipboard-holder.mjs", import.meta.url);
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dohc-clipboard-lock-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  let lockPath;
  if (process.platform === "win32") {
    lockPath = `\\\\.\\pipe\\dohc-clipboard-test-${randomUUID()}`;
  } else {
    const server = createServer();
    server.listen({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    lockPath = { host: "127.0.0.1", port: server.address().port, exclusive: true };
    await new Promise(resolve => server.close(resolve));
  }
  return { root, lockPath, register: join(root, "register") };
}
function holder(t, paths, name, mode, env = process.env) {
  const child = fork(childEntry, [JSON.stringify(paths.lockPath), name, paths.register, mode ?? "locked"], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const messages = [];
  const waiters = [];
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("message", message => {
    const waiter = waiters.findIndex(row => row.event === message.event);
    if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(message);
    else messages.push(message);
  });
  child.on("exit", code => {
    for (const { reject } of waiters.splice(0)) reject(new Error(`Holder exited (${code}): ${stderr}`));
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  });
  return {
    child,
    wait(event) {
      const index = messages.findIndex(message => message.event === event);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => waiters.push({ event, resolve, reject }));
    },
    send: command => child.send(command),
  };
}

test("two processes take turns across the entire write/read interval", { timeout: 15_000 }, async t => {
  const paths = await fixture(t);
  const first = holder(t, paths, "first test");
  await first.wait("acquired");
  const second = holder(t, paths, "second test");
  await second.wait("waiting");
  second.send("probe");
  assert.equal((await second.wait("probe")).entered, false);
  first.send("read");
  assert.equal((await first.wait("read")).text, "first test");
  first.send("release");
  await first.wait("released");
  await second.wait("acquired");
  second.send("read");
  assert.equal((await second.wait("read")).text, "second test");
  second.send("release");
  await second.wait("released");
  await withSystemClipboardLock({ lockPath: paths.lockPath, holder: "after release", timeoutMs: 1_000 }, async () => {});
});

test("the same unprotected write/read schedule observes the other process's text", { timeout: 15_000 }, async t => {
  const paths = await fixture(t);
  const first = holder(t, paths, "first text", "unlocked");
  await first.wait("acquired");
  const second = holder(t, paths, "other lane text", "unlocked");
  await second.wait("acquired");
  first.send("read");
  assert.equal((await first.wait("read")).text, "other lane text");
  for (const child of [first, second]) { child.send("release"); await child.wait("released"); }
});

test("killing a holder immediately frees the endpoint", { timeout: 15_000 }, async t => {
  const paths = await fixture(t);
  const dead = holder(t, paths, "dead test");
  await dead.wait("acquired");
  const exited = once(dead.child, "exit");
  dead.child.kill();
  await exited;
  await withSystemClipboardLock({ lockPath: paths.lockPath, holder: "replacement", timeoutMs: 1_000 }, async () => {});
});

test("failure releases the lock for a waiting process", { timeout: 15_000 }, async t => {
  const paths = await fixture(t);
  const first = holder(t, paths, "failing test");
  await first.wait("acquired");
  const second = holder(t, paths, "following test");
  await second.wait("waiting");
  first.send("fail");
  assert.match((await first.wait("failed")).message, /intentional holder failure/u);
  await second.wait("acquired");
  second.send("release");
  await second.wait("released");
  await withSystemClipboardLock({ lockPath: paths.lockPath, holder: "after release", timeoutMs: 1_000 }, async () => {});
});

test("the wait obeys its budget and identifies the holder", { timeout: 15_000 }, async t => {
  const paths = await fixture(t);
  const first = holder(t, paths, "occupied clipboard test");
  await first.wait("acquired");
  const started = performance.now();
  await assert.rejects(withSystemClipboardLock({ lockPath: paths.lockPath, holder: "waiting test", timeoutMs: 150 }, () => assert.fail("must not acquire")), error => {
    assert.match(error.message, /Timed out waiting for the system clipboard lock/u);
    assert.match(error.message, /occupied clipboard test/u);
    assert.ok(error.message.includes(`pid ${first.child.pid}`));
    assert.match(error.message, /started /u);
    return true;
  });
  assert.ok(performance.now() - started < 2_000, "the helper does not wait for its own default timeout");
  first.send("read");
  assert.equal((await first.wait("read")).text, "occupied clipboard test");
  first.send("release");
  await first.wait("released");
});

test("lane-local TEMP cannot change the Windows pipe name", { skip: process.platform !== "win32", timeout: 15_000 }, async t => {
  const paths = await fixture(t);
  const lockPaths = await Promise.all(["lane-a", "lane-b"].map(async lane => {
    const child = fork(childEntry, [JSON.stringify(paths.lockPath), "", paths.register, "path"], {
      env: { ...process.env, TEMP: join(paths.root, lane), TMP: join(paths.root, lane) },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    const exited = once(child, "exit");
    const [path] = await once(child, "message");
    await exited;
    return path;
  }));
  assert.equal(lockPaths[0], "\\\\.\\pipe\\dohc-e2e-system-clipboard");
  assert.equal(lockPaths[0], lockPaths[1]);
});

test("Playwright spans release after failure and worker timeout, and leave the clipboard free outside spans", { timeout: 20_000 }, async t => {
  const paths = await fixture(t);
  const config = join(paths.root, "playwright.config.mjs");
  writeFileSync(config, `export default ${JSON.stringify({
    testDir: fileURLToPath(new URL("./fixtures", import.meta.url)),
    testMatch: "system-clipboard.playwright.ts",
    workers: 1,
    retries: 0,
    reporter: "json",
    outputDir: join(paths.root, "results"),
  })};`);
  const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
  let report;
  try {
    await promisify(execFile)(process.execPath, [cli, "test", "--config", config], {
      env: { ...process.env, DOHC_CLIPBOARD_TEST_ADDRESS: JSON.stringify(paths.lockPath) },
      timeout: 15_000, windowsHide: true,
    });
    assert.fail("the synthetic assertion and timeout must fail");
  } catch (error) {
    assert.equal(error.code, 1, error.stderr ?? error.message);
    report = JSON.parse(error.stdout);
  }
  assert.equal(report.stats.expected, 3, JSON.stringify(report.suites.flatMap(suite => suite.specs).map(spec => ({ title: spec.title, errors: spec.tests[0].results[0].errors }))));
  assert.equal(report.stats.unexpected, 2);
  const specs = report.suites.flatMap(suite => suite.specs);
  assert.deepEqual(specs.map(spec => [spec.title, spec.tests[0].results[0].status]), [
    ["intentional failure", "failed"], ["acquires after failure", "passed"],
    ["intentional timeout", "timedOut"], ["acquires after timeout", "passed"],
    ["no lock outside spans", "passed"],
  ]);
});
