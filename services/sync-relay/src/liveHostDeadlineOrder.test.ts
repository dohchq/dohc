import {spawn} from "node:child_process";
import {expect, it} from "vitest";

// Measurement for #3914, not a behavior test. The relay sends an engine request over a pipe and starts its deadline
// timer on its own thread. This records, for each kind of callback that holds that thread past the deadline, whether
// a reply the engine wrote in time is read before the timer fires. It asserts only that every trial finished.
const DEADLINE_MS = 100, BUSY_MS = 250, TRIALS = 10;
const ENGINE = `
const {createInterface} = require("node:readline");
createInterface({input: process.stdin}).on("line", line => process.stdout.write(JSON.stringify({...JSON.parse(line), writtenAt: Date.now()}) + "\\n"));`;
type Where = "io" | "io-microtask" | "timer" | "immediate";
type Trial = {where: Where; busyMs: number; first: "reply" | "deadline"; answeredMs: number};

it("measure: reply and deadline order on a busy thread", {timeout: 120_000}, async () => {
  const engine = spawn(process.execPath, ["-e", ENGINE], {stdio: ["pipe", "pipe", "inherit"]});
  const waiting = new Map<number, (writtenAt: number) => void>();
  let buffered = "", next = 0;
  engine.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const reply = JSON.parse(buffered.slice(0, end)) as {id: number; writtenAt: number};
      buffered = buffered.slice(end + 1);
      waiting.get(reply.id)?.(reply.writtenAt); waiting.delete(reply.id);
    }
  });
  const ask = (answered: (writtenAt: number) => void) => {const id = ++next; waiting.set(id, answered); engine.stdin.write(JSON.stringify({id}) + "\n");};
  const busy = (ms: number) => {const end = performance.now() + ms; while (performance.now() < end) { /* the relay's thread is busy */ }};
  const trial = (where: Where, busyMs: number) => new Promise<Trial>(resolve => {
    const run = () => {
      const sentAt = Date.now();
      let first: Trial["first"] | undefined, answeredMs: number | undefined, fired = false;
      const done = () => {if (fired && answeredMs !== undefined) resolve({where, busyMs, first: first!, answeredMs});};
      setTimeout(() => {fired = true; first ??= "deadline"; done();}, DEADLINE_MS);
      ask(writtenAt => {answeredMs = writtenAt - sentAt; first ??= "reply"; done();});
      busy(busyMs);
    };
    if (where === "io") ask(() => run());
    else if (where === "io-microtask") ask(() => queueMicrotask(run));
    else if (where === "timer") setTimeout(run, 0);
    else setImmediate(run);
  });
  try {
    await new Promise<void>(resolve => ask(() => resolve()));
    const trials: Trial[] = [];
    for (const busyMs of [0, BUSY_MS]) for (const where of ["io", "io-microtask", "timer", "immediate"] as const) {
      for (let index = 0; index < TRIALS; index++) trials.push(await trial(where, busyMs));
    }
    const lines = [`[deadline-order] ${process.platform} ${process.arch} node ${process.version}, deadline ${DEADLINE_MS} ms, busy ${BUSY_MS} ms, ${TRIALS} trials each`];
    for (const busyMs of [0, BUSY_MS]) for (const where of ["io", "io-microtask", "timer", "immediate"] as const) {
      const group = trials.filter(each => each.where === where && each.busyMs === busyMs);
      const lost = group.filter(each => each.first === "deadline" && each.answeredMs < DEADLINE_MS);
      lines.push(`[deadline-order] busy ${busyMs} ms in ${where}: reply first ${group.filter(each => each.first === "reply").length}, ` +
        `deadline first ${group.filter(each => each.first === "deadline").length}, of those answered inside the deadline ${lost.length}; ` +
        `the engine wrote each reply within ${Math.max(...group.map(each => each.answeredMs))} ms of the request (clocks of two processes, 1 ms steps)`);
    }
    console.log(lines.join("\n"));
    expect(trials).toHaveLength(2 * 4 * TRIALS);
  } finally {engine.kill();}
});
