import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function open(script: Script, timing: { silenceMs: number; commandCapMs: number }, onLaunch?: (exit: () => void) => void) {
  const root = await mkdtemp(join(tmpdir(), "dohc-watchdog-test-"));
  roots.push(root);
  const launch: AppRuntimeLauncher = (options) => {
    let exited = false;
    onLaunch?.(() => { exited = true; options.onExit(null); });
    const send = (message: unknown) => { if (!exited) setImmediate(() => options.onMessage(message)); };
    send({ ready: true });
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
    send({ id: command.id, progress: "saving the change" });
  }, { silenceMs: 40, commandCapMs: 60_000 });
  await expect(worker.discard("proposal")).rejects.toMatchObject({
    code: "worker_stalled",
    message: "dohc made no progress on this Collection for 40 ms while saving the change. Try again.",
  });
});

it("lets a step with its own CPU budget stay quiet long enough to use it", async () => {
  const worker = await open((command, send) => {
    // A 100 ms budget: the host allows 40 ms + 2 × 100 ms of silence.
    send({ id: command.id, progress: "checking the tables", cpuBudgetMs: 100 });
    if (command.command.kind === "discard") setTimeout(() => send({ id: command.id, ok: true, result: null }), 120);
  }, { silenceMs: 40, commandCapMs: 60_000 });
  await expect(worker.discard("proposal")).resolves.toBeUndefined();
  await expect(worker.snapshot(join(roots.at(-1)!, "never.sqlite"))).rejects.toMatchObject({
    code: "worker_stalled",
    message: "dohc made no progress on this Collection for 240 ms while checking the tables. Try again.",
  });
});

it("fails a worker that keeps reporting but never finishes, at the command cap", async () => {
  let reporting: ReturnType<typeof setInterval> | undefined;
  const worker = await open((command, send) => {
    reporting = setInterval(() => send({ id: command.id, progress: "reapplying saved change 1 of 1" }), 10);
  }, { silenceMs: 40, commandCapMs: 200 });
  try {
    await expect(worker.discard("proposal")).rejects.toMatchObject({
      code: "worker_deadline",
      message: "dohc did not finish this Collection's work in 200 ms while reapplying saved change 1 of 1. Try again.",
    });
  } finally {
    clearInterval(reporting);
  }
});

it("says the app's code ran too long when the CPU budget watch ended the worker", async () => {
  let end!: () => void;
  const worker = await open((command, send) => {
    send({ id: command.id, progress: "running the Collection action" });
    // The worker's budget watch leaves its marker, then the process ends.
    setTimeout(() => void writeFile(join(roots.at(-1)!, "cpu-budget-exceeded"), "app 5000").then(end), 10);
  }, { silenceMs: 60_000, commandCapMs: 60_000 }, (exit) => { end = exit; });
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
    code: "worker_budget",
    message: "The app's code ran too long: it used more than 5 s of CPU time while running the Collection action. Try again.",
  });
});
