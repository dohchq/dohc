import { readFileSync, writeFileSync } from "node:fs";
import { withSystemClipboardLock, systemClipboardLockPath } from "../../apps/desktop/e2e/helpers/systemClipboardLock.mjs";

const [lockPath, holder, register, mode] = process.argv.slice(2);
if (mode === "path") {
  process.send(systemClipboardLockPath());
  process.disconnect();
} else {
  let entered = false;
  let release;
  const done = new Promise(resolve => { release = resolve; });
  process.on("message", command => {
    if (command === "probe") process.send({ event: "probe", entered });
    if (command === "read") process.send({ event: "read", text: readFileSync(register, "utf8") });
    if (command === "release" || command === "fail") release(command);
  });
  const use = async () => {
    entered = true;
    writeFileSync(register, holder);
    process.send({ event: "acquired" });
    if (await done === "fail") throw new Error("intentional holder failure");
  };
  process.send({ event: "waiting" });
  try {
    if (mode === "unlocked") await use();
    else await withSystemClipboardLock({ lockPath, holder, timeoutMs: 10_000 }, use);
    process.send({ event: "released" });
  } catch (error) {
    process.send({ event: "failed", message: error.message });
  } finally { process.disconnect(); }
}
