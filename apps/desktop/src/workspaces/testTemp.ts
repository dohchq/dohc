import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

export function nativeTmpdir(): string {
  // In WSL, os.tmpdir() can inherit Windows TEMP/TMP and land under /mnt/c,
  // where watcher and SQLite behavior can differ from native Linux temp.
  // Windows keeps using the platform temp dir.
  return process.platform !== "win32" && existsSync("/tmp") ? "/tmp" : tmpdir();
}
