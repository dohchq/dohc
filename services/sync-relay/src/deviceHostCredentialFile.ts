import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDeviceHostCredential, parseDeviceHostCredential, type DeviceHostCredential } from "./deviceHostCredential.js";
import type { HostEpoch } from "@dohc/live-session-contract/host-control";

const windowsAccess = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:DOHC_HOST_CREDENTIAL_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:DOHC_HOST_CREDENTIAL_CREATE -eq '1') {
  $acl = [System.IO.Directory]::GetAccessControl($path)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  [System.IO.Directory]::SetAccessControl($path, $acl)
}
if ($env:DOHC_HOST_CREDENTIAL_DIRECTORY -eq '1') { $acl = [System.IO.Directory]::GetAccessControl($path) }
else { $acl = [System.IO.File]::GetAccessControl($path) }
if ($env:DOHC_HOST_CREDENTIAL_DIRECTORY -eq '1' -and !$acl.AreAccessRulesProtected) { throw 'Unprotected directory' }
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Foreign owner' }
if ($acl.Access.Count -eq 0) { throw 'Missing access rule' }
foreach ($rule in $acl.Access) {
  if ($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or
      $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { throw 'Unexpected access rule' }
}`;

async function privatePath(path: string, directory: boolean, create = false): Promise<void> {
  const stat = await lstat(path);
  const actualPath = resolve(await realpath(path)), requestedPath = resolve(path);
  const samePath = process.platform === "win32" ? actualPath.toLowerCase() === requestedPath.toLowerCase() : actualPath === requestedPath;
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
    !samePath) throw new Error("Invalid credential path.");
  if (process.platform === "win32") {
    execFileSync(join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsAccess], {
        windowsHide: true, stdio: "pipe", timeout: 10_000,
        env: { ...process.env, DOHC_HOST_CREDENTIAL_PATH: path, DOHC_HOST_CREDENTIAL_CREATE: create ? "1" : "0",
          DOHC_HOST_CREDENTIAL_DIRECTORY: directory ? "1" : "0" },
      });
  } else if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) {
    throw new Error("Credential path must be accessible only to its owner.");
  }
}

// Persist the secret before provisioning. A crash can then retry with the same file.
export async function prepareDeviceHostCredentialFile(directory: string, hostId: string, hostEpoch: HostEpoch): Promise<DeviceHostCredential> {
  let created = false;
  try { await mkdir(directory, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (created && process.platform !== "win32") await chmod(directory, 0o700);
  await privatePath(directory, true, created);
  const path = join(directory, "device-host-credential.json");
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    await privatePath(path, false);
    const handle = await open(path, "r");
    try {
      if ((await handle.stat()).size > 8_192) throw new Error("Invalid credential file.");
      const credential = parseDeviceHostCredential(JSON.parse(await handle.readFile("utf8")));
      if (credential.hostId !== hostId || credential.hostEpoch !== hostEpoch) throw new Error("Credential scope differs.");
      return credential;
    } finally { await handle.close(); }
  }
  const credential = createDeviceHostCredential(hostId, hostEpoch);
  const handle = await open(path, "wx", 0o600);
  try {
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(credential) + "\n");
    await handle.sync();
  }
  finally { await handle.close(); }
  await privatePath(path, false);
  if (process.platform !== "win32") {
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }
  return credential;
}
