import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseMoveArguments, runMove } from "./move.mjs";

async function envFile(t, contents) {
  const root = await mkdtemp(join(tmpdir(), "dohc-move-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "deployment.env");
  await writeFile(path, contents);
  return path;
}
function runner(checkStatus = 0) {
  const calls = [];
  return { calls, run(command, args) {
    calls.push([command, ...args]);
    return command === "docker" ? checkStatus : 0;
  } };
}

test("move checks the attached disk through the relay volumes before starting and checking the deployment", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=/mnt/disk/dohc\n"), mock = runner();
  runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {});
  assert.equal(mock.calls.length, 2);
  const [check, start] = mock.calls;
  assert.ok(check.includes("tools/self-host/compose.data-disk.yml"));
  assert.deepEqual(check.slice(check.indexOf("run")), ["run", "--rm", "--no-deps", "-T", "--entrypoint", "node", "relay-initialize", "-e", check.at(-1)]);
  assert.match(check.at(-1), /\/continuity\/deployment\.json/);
  assert.deepEqual(start.slice(1), ["scripts/check-self-host.mjs", "--start", "--env-file", path]);
});

test("move never starts a disk without a relay deployment", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=/mnt/disk/dohc\n"), mock = runner(1);
  assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {}), /No relay deployment found in \/mnt\/disk\/dohc/);
  assert.deepEqual(mock.calls.map(([command]) => command), ["docker"]);
});

test("move refuses a deployment that keeps relay data in host volumes before Docker runs", async t => {
  const path = await envFile(t, "DOHC_DATA_DIRECTORY=\n"), mock = runner();
  assert.throws(() => runMove(parseMoveArguments(["--env-file", path]), mock.run, () => {}), /Set DOHC_DATA_DIRECTORY/);
  assert.deepEqual(mock.calls, []);
});

test("move accepts only an env file option", () => {
  for (const args of [["--env-file"], ["--env-file", "--start"], ["--project-name", "dohc"], ["extra"]]) {
    assert.throws(() => parseMoveArguments(args), /move\.mjs \[--env-file PATH\]/);
  }
});
