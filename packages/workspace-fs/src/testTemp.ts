import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

export function nativeTmpdir(): string {
  // In WSL, os.tmpdir() can inherit Windows TEMP/TMP and land under /mnt/c,
  // where chokidar may not receive inotify events. Watcher tests need a native
  // Linux filesystem so a red test means watcher behavior, not DrvFs plumbing.
  return process.platform !== "win32" && existsSync("/tmp") ? "/tmp" : tmpdir();
}
