import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { openPersistentAppBackend } from "./persistent.ts";
import type { AppRuntimeLauncher } from "./protocol.ts";

// A scripted worker: the host's watchdog is the unit under test, so each test
// decides which progress messages the worker sends and whether it answers.
type Command = { id: number; command: { kind: string } };
type Script = (command: Command, send: (message: unknown) => void) => void;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function open(script: Script, timing: { silenceMs: number; commandCapMs: number }, deadlineMs?: number) {
  const root = await mkdtemp(join(tmpdir(), "dohc-watchdog-test-"));
  roots.push(root);
  const launch: AppRuntimeLauncher = (options) => {
    let exited = false;
    const send = (message: unknown) => { if (!exited) setImmediate(() => options.onMessage(message)); };
    return {
      postMessage(message) {
        const command = message as Command;
        if (command.command.kind === "open") {
          send({ id: command.id, ok: true, result: { revision: 0, digest: hash("initial") } });
          return;
        }
        if (command.command.kind === "close") {
          send({ id: command.id, ok: true, result: null });
          return;
        }
        script(command, send);
      },
      kill() {
        if (exited) return;
        exited = true;
        setImmediate(() => options.onExit(null));
      },
    };
  };
  return await openPersistentAppBackend(
    {
      directory: root,
      schemaSql: "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL);",
      tables: ["items"],
      scope: { workspaceId: "workspace", datasetId: "dataset", hostEpoch: "epoch-1", approvedRevisionHash: hash("approved") },
      cursor: { revision: 0, digest: hash("initial") },
      ...(deadlineMs ? { limits: { deadlineMs } } : {}),
    },
    { launch, entryPath: join(root, "worker.mjs"), ...timing },
  );
}

it("keeps slow I/O work alive while the worker reports progress", async () => {
  let steps = 0;
  const worker = await open((command, send) => {
    // Six silence windows of work, one progress message per window.
    const tick = () => {
      if (++steps <= 12) {
        send({ id: command.id, progress: `step ${steps}` });
        setTimeout(tick, 20);
      } else send({ id: command.id, ok: true, result: null });
    };
    tick();
  }, { silenceMs: 40, commandCapMs: 60_000 });
  await expect(worker.discard("proposal")).resolves.toBeUndefined();
  expect(steps).toBe(13);
  await worker.close();
});

it("fails a worker that stops reporting, naming the step it stopped in", async () => {
  const worker = await open((command, send) => {
    send({ id: command.id, progress: "committing the operation" });
  }, { silenceMs: 40, commandCapMs: 60_000 });
  await expect(worker.discard("proposal")).rejects.toMatchObject({
    code: "worker_stalled",
    message: "The dataset worker made no progress for 40 ms while committing the operation. Reopen it from the journal.",
  });
});

it("fails a worker that keeps reporting but never finishes, at the command cap", async () => {
  let reporting: ReturnType<typeof setInterval> | undefined;
  const worker = await open((command, send) => {
    reporting = setInterval(() => send({ id: command.id, progress: "replaying journal event 1 of 1" }), 10);
  }, { silenceMs: 40, commandCapMs: 200 });
  try {
    await expect(worker.discard("proposal")).rejects.toMatchObject({
      code: "worker_deadline",
      message: "The dataset worker did not finish in 200 ms while replaying journal event 1 of 1. Reopen it from the journal.",
    });
  } finally {
    clearInterval(reporting);
  }
});

it("does not treat progress as more time for app code", async () => {
  const worker = await open((command, send) => {
    // Reports well past its deadline; app code is bounded by the deadline alone.
    const reporting = setInterval(() => send({ id: command.id, progress: "running the app operation" }), 10);
    setTimeout(() => clearInterval(reporting), 2_000);
  }, { silenceMs: 40, commandCapMs: 60_000 }, 200);
  await expect(
    worker.prepare({
      source: "globalThis.operations={run(){return 1}}",
      operation: "run",
      input: {},
      caller: { kind: "owner" },
      nowMs: 1000,
      requestId: "request",
      expected: { revision: 0, digest: hash("initial") },
    }),
  ).rejects.toMatchObject({
    code: "worker_deadline",
    message: "The dataset worker exceeded its deadline while running the app operation. Reopen it from the journal.",
  });
});
