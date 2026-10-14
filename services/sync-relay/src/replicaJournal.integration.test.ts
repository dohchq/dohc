import {spawn} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";
import {requireEngineBinaryOrSkip} from "../../../apps/desktop/src/testing/engineBinary";

const binary = requireEngineBinaryOrSkip();
async function fixture(mode: "device" | "service", sizes = [50 * 1024], existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), "dohc-replica5c-"));
  const child = spawn(process.execPath, ["--import", "tsx/esm", fileURLToPath(new URL("./replicaJournal.integration.fixture.ts", import.meta.url)), root, binary.require(), mode],
    {cwd: fileURLToPath(new URL("..", import.meta.url)), windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  const pending = new Map<number, {resolve: (value: any) => void; reject: (error: Error) => void}>();
  let ready!: () => void, fail!: (error: Error) => void, logs = "", id = 1, childClosed = false;
  const started = new Promise<void>((resolve, reject) => {ready = resolve; fail = reject;});
  child.stderr.on("data", bytes => {logs += String(bytes);});
  const lines = createInterface({input: child.stdout});
  lines.on("line", line => {
    const value = JSON.parse(line);
    if (value.ready) ready();
    else {const request = pending.get(value.id); pending.delete(value.id); if (value.error) request?.reject(new Error(`${value.stack}\n${logs}`)); else request?.resolve(value.result);}
  });
  child.on("close", () => {childClosed = true; const error = new Error(`Relay exited: ${logs}`); fail(error); for (const request of pending.values()) request.reject(error);});
  function call(name: string, input: Record<string, unknown> = {}): Promise<any> {
    if (childClosed) return Promise.reject(new Error(`Relay exited: ${logs}`));
    const requestId = id++;
    return new Promise((resolve, reject) => {pending.set(requestId, {resolve, reject}); child.stdin.write(JSON.stringify({id: requestId, name, input}) + "\n");});
  }
  try {await started; const processes = await call("init", {sizes, resume: Boolean(existingRoot)});
    expect(processes.relayPid).toBe(child.pid); expect(processes.hostPid).not.toBe(child.pid); expect(processes.replicaPid).not.toBe(processes.hostPid);
    const stopCrashedChildren = async () => {
      for (const pid of [processes.hostPid, processes.replicaPid]) {
        try {process.kill(pid, "SIGKILL");} catch (error) {if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;}
        const deadline = performance.now() + 30_000;
        for (;;) {
          try {process.kill(pid, 0);} catch (error) {if ((error as NodeJS.ErrnoException).code === "ESRCH") break; throw error;}
          expect(performance.now()).toBeLessThan(deadline);
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
    };
    return {root, call, processes, async crashed() {
      await exited; lines.close(); await stopCrashedChildren();
    }, async close(keepRoot = false) {try {if (!childClosed) await call("close");} finally {child.stdin.end(); child.kill(); await exited; lines.close(); if (!keepRoot && process.env.DOHC_REPLICA_RETAIN !== "1") await rm(root, {recursive: true, force: true}); else console.log(`RETAINED=${root}`);}}};
  } catch (error) {await call("close").catch(() => {}); child.kill(); await exited; lines.close(); if (process.env.DOHC_REPLICA_RETAIN !== "1") await rm(root, {recursive: true, force: true}); else console.log(`RETAINED=${root}`); throw error;}
}

it.skipIf(binary.missing).each(["device", "service"] as const)("%s host: journal precedes echo with equal evidence and no duplicate History", async mode => {
  const samples: Record<string, number[]> = {};
  for (const size of [50 * 1024, 1024 * 1024]) {
    const f = await fixture(mode, [size]);
    try {
      const times: number[] = [];
      for (let sample = 0; sample < (process.env.DOHC_REPLICA_MEASURE === "1" ? 21 : 2); sample++) {
        const start = performance.now();
        const receipt = await f.call("edit", {deliveryId: `${mode}-${size}-${sample}`});
        await f.call("settled"); times.push(performance.now() - start);
        const cut = await f.call("state");
        expect(cut.frontier[0].journal_cursor).toBe(receipt.receipt.journalCursor);
        await f.call("drain"); expect((await f.call("compare")).errors).toEqual([]);
      }
      samples[String(size)] = times;
      const before = await f.call("state");
      await f.call("settle"); await f.call("echo");
      const after = await f.call("state");
      expect(after.accepted).toEqual(before.accepted); expect(after.passive).toEqual(before.passive);
      expect((await f.call("compare")).errors).toEqual([]);
    } finally {await f.close();}
  }
  if (process.env.DOHC_REPLICA_MEASURE_OUT) await writeFile(`${process.env.DOHC_REPLICA_MEASURE_OUT}-${mode}.json`, JSON.stringify(samples));
}, 600_000);

it.skipIf(binary.missing)("host killed after commit: journal survives, restart echoes once", async () => {
  const f = await fixture("device", [1024]);
  try {
    await f.call("hold"); await f.call("edit", {deliveryId: "committed-before-kill"}); await f.call("held"); await f.call("killHost");
    const start = performance.now(); await f.call("release"); await f.call("settled");
    const accepted = await f.call("state"); expect(accepted.passive[0].eventCount).toBe(1); expect(accepted.owner[0].eventCount).toBe(0);
    const catchupMs = performance.now() - start;
    await f.call("restartHost"); await f.call("drain"); await f.call("compare");
    await f.call("settle"); await f.call("echo"); const after = await f.call("compare");
    expect(after.passive[0].eventCount).toBe(1); expect(after.errors).toEqual([]);
    console.log(JSON.stringify({scenario: "host-kill", catchupMs}));
  } finally {await f.close();}
}, 120_000);

it.skipIf(binary.missing)("restore while an old-generation page is in flight steps only at the restore application", async () => {
  const f = await fixture("service", [1024]);
  try {
    await f.call("edit", {deliveryId: "prime"}); await f.call("drain"); await f.call("compare");
    await f.call("hold"); await f.call("edit", {deliveryId: "old-in-flight"}); await f.call("held");
    await f.call("restore"); await f.call("release"); await f.call("settled");
    const compared = await f.call("compare"); expect(compared.passive[0].text).toBe("a".repeat(1024)); expect(compared.passive[0].eventCount).toBe(3);
    const cut = await f.call("state"); expect(cut.errors).toEqual([]);
    await f.call("echo"); await f.call("compare");
    await f.call("hold"); await f.call("edit", {deliveryId: "after-restore"}); await f.call("held");
    expect(await f.call("probeGeneration", {generation: 1})).toMatchObject({refused: true});
    expect(await f.call("probeGeneration", {generation: 3})).toMatchObject({refused: true});
    const refused = await f.call("state"); expect(refused.frontier[0].journal_cursor).toBe(3); expect(refused.passive[0].eventCount).toBe(3);
    await f.call("release"); await f.call("settled"); await f.call("drain"); await f.call("compare");
  } finally {await f.close();}
}, 120_000);

it.skipIf(binary.missing).each([false, true])("retired lineage skips an in-flight page after delete (rename=%s)", async rename => {
  const f = await fixture("service", [1024]);
  try {
    await f.call("edit", {deliveryId: "prime"}); await f.call("drain"); await f.call("compare");
    await f.call("settle"); await f.call("echo");
    await f.call("hold"); await f.call("edit", {deliveryId: "retired-in-flight"}); await f.call("held");
    await f.call("drain"); await f.call("settle"); await f.call("delete", {rename});
    await f.call("ordinaryInFlight"); await f.call("release"); await f.call("settled");
    const compared = await f.call("compare"); expect(compared.owner).toEqual([]); expect(compared.errors).toEqual([]);
    const cut = await f.call("state"); expect(cut.applications, JSON.stringify(cut.applications)).toContainEqual(expect.objectContaining({journalCursor: 2, skipped: 1}));
  } finally {await f.close();}
}, 120_000);

it.skipIf(binary.missing)("replica killed with a page write transaction open rolls back and rebuilds without duplicate application", async () => {
  const f = await fixture("service", [1024]);
  try {
    await f.call("hold", {beforeRead: true});
    for (let i = 0; i < 64; i++) await f.call("edit", {deliveryId: `page-${i}`});
    await f.call("held");
    const killing = f.call("killApplying"); await f.call("release");
    const interrupted = await killing; expect(interrupted.frontier.journal_cursor).toBe(0); expect(interrupted.accepted.n).toBe(0);
    await f.call("settled"); const start = performance.now(); await f.call("activate"); await f.call("activated");
    const elapsed = performance.now() - start;
    await f.call("drain"); const compared = await f.call("compare"); expect(compared.passive[0].eventCount).toBe(64);
    await f.call("settle"); await f.call("echo"); await f.call("compare");
    console.log(JSON.stringify({scenario: "replica-restart", catchupMs: elapsed}));
  } finally {await f.close();}
}, 180_000);

it.skipIf(binary.missing)("relay process is killed during a journal page and restarts", async () => {
  let f = await fixture("service", [1024]);
  try {
    await f.call("hold", {beforeRead: true}); for (let i = 0; i < 64; i++) await f.call("edit", {deliveryId: `relay-page-${i}`});
    await f.call("held"); const killing = f.call("killApplying", {relay: true}); await f.call("release");
    const interrupted = await killing; await f.crashed();
    expect(interrupted.frontier.journal_cursor).toBe(0); expect(interrupted.accepted.n).toBe(0);
    const root = f.root, oldPid = f.processes.relayPid;
    const start = performance.now(); f = await fixture("service", [1024], root);
    expect(f.processes.relayPid).not.toBe(oldPid); const catchupMs = performance.now() - start;
    await f.call("drain"); const compared = await f.call("compare"); expect(compared.passive[0].eventCount).toBe(64);
    await f.call("settle"); await f.call("echo"); await f.call("compare");
    console.log(JSON.stringify({scenario: "relay-restart", catchupMs}));
  } finally {await f.close();}
}, 180_000);

it.skipIf(binary.missing)("same lineage resent after an epoch-floor drain cannot reopen a pre-floor live session", async () => {
  const f = await fixture("device", [1024]);
  try {
    await f.call("edit", {deliveryId: "pre-epoch"}); await f.call("drain"); await f.call("compare");
    const empty = await f.call("epoch"); expect(empty.passive).toEqual([]); expect(empty.frontier[0].journal_cursor).toBe(1);
    const resent = await f.call("resend"); expect(resent.authority).toEqual({kind: "refused", reason: "stale-document"});
    expect(resent.registered.kind).toBe("refused"); expect(resent.passive[0].eventCount).toBe(0); expect(resent.starts).toBe(2);
    await f.call("evict"); await f.call("activate"); await f.call("activated");
    const rebuilt = await f.call("compare"); expect(rebuilt.passive[0].eventCount).toBe(1); expect(rebuilt.starts).toBe(3);
    await f.call("evict"); await f.call("activate"); await f.call("activated");
    const activated = await f.call("compare"); expect(activated.starts).toBe(4); expect(activated.errors).toEqual([]);
  } finally {await f.close();}
}, 120_000);
