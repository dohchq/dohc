import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

export function nativeTmpdir(): string {
  // In WSL, os.tmpdir() can inherit Windows TEMP/TMP and land under /mnt/c,
  // where file watching and rename semantics differ from native Linux temp.
  return process.platform !== "win32" && existsSync("/tmp") ? "/tmp" : tmpdir();
}
