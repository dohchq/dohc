import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as poll } from "node:timers/promises";

export const systemClipboardLockPath = () => join(process.env.DOHC_HOST_TMPDIR ?? tmpdir(), "dohc-e2e-system-clipboard.lock");

const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
};
const readHolder = path => {
  try { return JSON.parse(readFileSync(join(path, "holder.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

/** The caller supplies its remaining test budget, including any earlier setup. */
export async function withSystemClipboardLock({ timeoutMs, holder, lockPath = systemClipboardLockPath() }, use) {
  const deadline = performance.now() + timeoutMs;
  const owner = { pid: process.pid, startedAt: new Date().toISOString(), holder, token: randomUUID() };
  const candidate = mkdtempSync(join(dirname(lockPath), "dohc-clipboard-contender-"));
  let acquired = false;
  let observed;
  try {
    // Publish a complete, exclusively created record. A crash cannot leave an ownerless lock.
    writeFileSync(join(candidate, "holder.json"), JSON.stringify(owner), { flag: "wx" });
    for (;;) {
      if (performance.now() >= deadline) {
        const name = observed
          ? `${observed.holder} (pid ${observed.pid}, started ${observed.startedAt})`
          : "an owner whose record is not yet readable";
        throw new Error(`Timed out waiting for the system clipboard lock at ${lockPath}; held by ${name}.`);
      }
      try {
        // Renaming onto an existing nonempty directory fails atomically on Windows and POSIX.
        renameSync(candidate, lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
      }
      observed = readHolder(lockPath);
      if (!observed) continue;
      if (Number.isSafeInteger(observed.pid) && observed.pid > 0 && !alive(observed.pid)) {
        // Keep this nonempty tombstone until temp cleanup. A second stale waiter cannot
        // rename a successor over it, even if it was paused after reading the dead owner.
        const retired = `${lockPath}.stale-${observed.token}`;
        try { renameSync(lockPath, retired); }
        catch (error) {
          if (error.code !== "ENOENT" && !existsSync(retired)) throw error;
        }
        continue;
      }
      await poll(Math.min(50, Math.max(0, deadline - performance.now())));
    }
    return await use();
  } finally {
    if (acquired) rmSync(lockPath, { recursive: true });
    else rmSync(candidate, { recursive: true, force: true });
  }
}
