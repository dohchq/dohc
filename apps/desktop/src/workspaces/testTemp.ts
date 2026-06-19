import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

export function nativeTmpdir(): string {
  return process.platform !== "win32" && existsSync("/tmp") ? "/tmp" : tmpdir();
}
