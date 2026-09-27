import { execFile } from "node:child_process";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// libuv's Windows rename omits WRITE_THROUGH. Use the OS primitive before
// acknowledging a report whose engine copy will be deleted.
const replaceOnWindows = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class NoticeFile {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool MoveFileEx(string from, string to, uint flags);
  public static void Replace(string from, string to) {
    if (!MoveFileEx(from, to, 9)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
[NoticeFile]::Replace($env:DOHC_NOTICE_TEMP, $env:DOHC_NOTICE_TARGET)
`;

export async function writeDurableNoticeFile(path: string, contents: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flush: true });
  if (process.platform === "win32") {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", replaceOnWindows], {
      windowsHide: true,
      env: { ...process.env, DOHC_NOTICE_TEMP: temporary, DOHC_NOTICE_TARGET: path },
    });
  } else {
    await rename(temporary, path);
    for (const name of [directory, dirname(directory)]) {
      const handle = await open(name, "r");
      try { await handle.sync(); } finally { await handle.close(); }
    }
  }
}
