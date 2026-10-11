import { existsSync, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function waitForEnginePublicationGate(gate: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!existsSync(gate)) return;
  await writeFile(gate + ".waiting", "waiting");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      watcher.close();
      signal.removeEventListener("abort", aborted);
    };
    const done = () => {cleanup(); resolve();};
    const aborted = () => {cleanup(); reject(signal.reason);};
    const watcher = watch(dirname(gate), () => {if (!existsSync(gate)) done();});
    watcher.on("error", error => {cleanup(); reject(error);});
    signal.addEventListener("abort", aborted, {once: true});
    if (signal.aborted) aborted();
    else if (!existsSync(gate)) done();
  });
}
