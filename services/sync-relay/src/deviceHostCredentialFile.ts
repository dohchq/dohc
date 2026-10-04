import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDeviceHostCredential, parseDeviceHostCredential, type DeviceHostCredential } from "./deviceHostCredential.js";
import { openWindowsCredentialAcl, type WindowsCredentialAcl } from "./windowsCredentialAcl.js";
import type { HostEpoch } from "@dohc/live-session-contract/host-control";

export class DeviceHostCredentialFileUnavailable extends Error {
  constructor() {
    super("Device host credential files are unavailable on macOS because ACL validation is not implemented.");
  }
}

export function requireDeviceHostCredentialFileSupport(): void {
  if (process.platform === "darwin") throw new DeviceHostCredentialFileUnavailable();
}

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

function openCredentialAcl(): WindowsCredentialAcl | undefined {
  return process.platform === "win32" ? openWindowsCredentialAcl(windowsAccess) : undefined;
}

async function privatePath(acl: WindowsCredentialAcl | undefined, path: string, directory: boolean, { create = false, final = false } = {}): Promise<BigIntStats> {
  const stat = await lstat(path, { bigint: true });
  const actualPath = resolve(await realpath(path)), requestedPath = resolve(path);
  const samePath = process.platform === "win32" ? actualPath.toLowerCase() === requestedPath.toLowerCase() : actualPath === requestedPath;
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
    !samePath) throw new Error("Invalid credential path.");
  if (acl) {
    await acl.check(path, directory, create, final);
  } else if (stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o777n) !== (directory ? 0o700n : 0o600n)) {
    throw new Error("Credential path must be accessible only to its owner.");
  }
  return stat;
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function syncCredentialDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const parent = await open(directory, "r");
  try { await parent.sync(); } finally { await parent.close(); }
}

// Persist the secret before provisioning. A crash can then retry with the same file.
export async function prepareDeviceHostCredentialFile(directory: string, hostId: string, hostEpoch: HostEpoch): Promise<DeviceHostCredential> {
  requireDeviceHostCredentialFileSupport();
  const acl = openCredentialAcl();
  try { return await prepareCredential(acl, directory, hostId, hostEpoch); } finally { if (acl) await acl.close(); }
}

async function prepareCredential(acl: WindowsCredentialAcl | undefined, directory: string, hostId: string, hostEpoch: HostEpoch): Promise<DeviceHostCredential> {
  let created = false;
  try { await mkdir(directory, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (created && process.platform !== "win32") await chmod(directory, 0o700);
  await privatePath(acl, directory, true, { create: created });
  const path = join(directory, "device-host-credential.json");
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    const identity = await privatePath(acl, path, false, { final: true });
    const handle = await open(path, "r+");
    let credential: DeviceHostCredential;
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameFile(opened, identity)) throw new Error("Credential file changed.");
      if (opened.size > 8_192n) throw new Error("Invalid credential file.");
      credential = parseDeviceHostCredential(JSON.parse(await handle.readFile("utf8")));
      if (credential.hostId !== hostId || credential.hostEpoch !== hostEpoch) throw new Error("Credential scope differs.");
      await handle.sync();
    } finally { await handle.close(); }
    await syncCredentialDirectory(directory);
    return credential;
  }
  const credential = createDeviceHostCredential(hostId, hostEpoch);
  const temporary = join(directory, `.device-host-credential-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let identity: BigIntStats | undefined;
  try {
    identity = await handle.stat({ bigint: true });
    if (process.platform !== "win32") await handle.chmod(0o600);
    if (!sameFile(await privatePath(acl, temporary, false), identity)) throw new Error("Credential file changed.");
    await handle.writeFile(JSON.stringify(credential) + "\n");
    await handle.sync();
    if (!sameFile(await privatePath(acl, temporary, false, { final: true }), identity)) throw new Error("Credential file changed.");
    await link(temporary, path);
    await handle.sync();
  } finally {
    await handle.close();
    const current = await lstat(temporary, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (identity && current?.isFile() && sameFile(current, identity)) await unlink(temporary);
  }
  await syncCredentialDirectory(directory);
  return credential;
}

export async function readDeviceHostCredentialFile(directory: string): Promise<DeviceHostCredential> {
  requireDeviceHostCredentialFileSupport();
  const acl = openCredentialAcl();
  try { return await readCredential(acl, directory); } finally { if (acl) await acl.close(); }
}

async function readCredential(acl: WindowsCredentialAcl | undefined, directory: string): Promise<DeviceHostCredential> {
  await privatePath(acl, directory, true);
  const path = join(directory, "device-host-credential.json");
  const identity = await privatePath(acl, path, false, { final: true });
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(opened, identity)) throw new Error("Credential file changed.");
    if (opened.size > 8_192n) throw new Error("Invalid credential file.");
    return parseDeviceHostCredential(JSON.parse(await handle.readFile("utf8")));
  } finally { await handle.close(); }
}
