import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

// Polls for the gate's removal. A directory watcher misses it on macOS: the
// test removes the gate as soon as it sees `.waiting`, which can land before
// a new FSEvents stream delivers anything.
const GATE_POLL_MS = 25;

export async function waitForEnginePublicationGate(gate: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!existsSync(gate)) return;
  await writeFile(gate + ".waiting", "waiting");
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearInterval(timer);
      signal.removeEventListener("abort", aborted);
    };
    const aborted = () => {stop(); reject(signal.reason);};
    const timer = setInterval(() => {if (!existsSync(gate)) {stop(); resolve();}}, GATE_POLL_MS);
    signal.addEventListener("abort", aborted, {once: true});
    if (signal.aborted) aborted();
  });
}
