// Cross-platform "unreadable path" fixtures for tests. Access denial is
// chmod 0o000 on POSIX and an explicit NTFS deny-read ACE on Windows (POSIX
// modes do not exist there). The denied operation surfaces as EACCES on
// POSIX and EPERM on Windows.
import { execFileSync } from "node:child_process";
import { chmod } from "node:fs/promises";
import { userInfo } from "node:os";

export const deniedReadCode = process.platform === "win32" ? "EPERM" : "EACCES";

export async function denyRead(absolute: string, kind: "dir" | "file"): Promise<void> {
  if (process.platform === "win32") {
    const user = userInfo().username;
    const ace = kind === "dir" ? `${user}:(OI)(CI)(R)` : `${user}:(R)`;
    execFileSync("icacls", [absolute, "/inheritance:r", "/deny", ace], { stdio: "pipe" });
    return;
  }
  await chmod(absolute, 0o000);
}

export async function restoreRead(absolute: string, mode: number): Promise<void> {
  if (process.platform === "win32") {
    const user = userInfo().username;
    try {
      execFileSync("icacls", [absolute, "/remove:d", user], { stdio: "pipe" });
      execFileSync("icacls", [absolute, "/inheritance:e"], { stdio: "pipe" });
    } catch {
      // Fixture may not exist or never got the deny ACE; cleanup is best-effort.
    }
    return;
  }
  await chmod(absolute, mode);
}
