import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

export function nativeTmpdir(): string {
  // In WSL, os.tmpdir() can inherit Windows TEMP/TMP and land under /mnt/c,
  // where native watchers may not receive inotify events.
  return process.platform !== "win32" && existsSync("/tmp") ? "/tmp" : tmpdir();
}
