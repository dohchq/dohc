import { execFile, spawn, type ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { prepareDeviceHostCredentialFile, readDeviceHostCredentialFile } from "./deviceHostCredentialFile.js";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const exec = promisify(execFile), system32 = join(process.env.SystemRoot ?? "C:/Windows", "System32");
const icacls = (...args: string[]) => exec(join(system32, "icacls.exe"), args, { windowsHide: true });
const epoch = parseHostEpoch(1), everyone = "*S-1-1-0";
const launched = () => vi.mocked(spawn).mock.results.map(result => result.value as ChildProcess);
let root: string, sid: string;

// Foreign-owner refusal is not covered here: assigning another owner needs privileges these runs lack.
describe.skipIf(process.platform !== "win32")("Windows credential ACL checks", () => {
  beforeAll(async () => {
    const { stdout } = await exec(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
    sid = /S-1-[\d-]+/.exec(stdout)![0];
  });
  beforeEach(async () => {
    const scratch = fileURLToPath(new URL("../.output/", import.meta.url));
    await actual.mkdir(scratch, { recursive: true });
    root = await actual.mkdtemp(join(scratch, "credential-acl-"));
    vi.mocked(spawn).mockClear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(open).mockReset();
    if (!root) return;
    await icacls(root, "/reset", "/T", "/C", "/Q");
    await actual.rm(root, { recursive: true, force: true });
  });

  async function provisioned() {
    const directory = join(root, "private"), file = join(directory, "device-host-credential.json");
    const credential = await prepareDeviceHostCredentialFile(directory, "host", epoch);
    vi.mocked(spawn).mockClear();
    return { directory, file, credential, bytes: await actual.readFile(file) };
  }

  it("serves each operation's checks from its own child, which exits cleanly", async () => {
    const directory = join(root, "cred it's $(calc) `ü 漢 & ; %PATH%");
    const credential = await prepareDeviceHostCredentialFile(directory, "host", epoch);
    expect(await readDeviceHostCredentialFile(directory)).toEqual(credential);
    expect(await prepareDeviceHostCredentialFile(directory, "host", epoch)).toEqual(credential);
    const children = launched();
    expect(children).toHaveLength(3);
    expect(new Set(children).size).toBe(3);
    expect(children.map(child => child.exitCode)).toEqual([0, 0, 0]);
    for (const [, args] of vi.mocked(spawn).mock.calls) expect(args.join(" ")).not.toContain(directory);
  });

  it.each(["before its first check", "between its two checks"] as const)(
    "refuses a temporary file widened %s without publishing it", async when => {
      const directory = join(root, "private"), file = join(directory, "device-host-credential.json");
      vi.mocked(open).mockImplementation(async (...args) => {
        const handle = await actual.open(...args);
        if (args[1] !== "wx") return handle;
        const widen = () => icacls(String(args[0]), "/grant", `${everyone}:R`);
        if (when === "before its first check") await widen();
        else {
          const write = handle.writeFile.bind(handle);
          vi.spyOn(handle, "writeFile").mockImplementation(async (...writeArgs) => { await write(...writeArgs); await widen(); });
        }
        return handle;
      });
      await expect(prepareDeviceHostCredentialFile(directory, "host", epoch)).rejects.toThrow("Unexpected access rule");
      await expect(actual.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await actual.readdir(directory)).toEqual([]);
      expect(launched().map(child => child.exitCode)).toEqual([1]);
    });

  it.each([
    ["grants another SID access", "Unexpected access rule", (file: string) => icacls(file, "/grant", `${everyone}:R`)],
    ["denies its owner a right", "Unexpected access rule", (file: string) => icacls(file, "/deny", `*${sid}:(WEA)`)],
    ["grants its owner less than full control", "Unexpected access rule", (file: string) => icacls(file, "/grant:r", `*${sid}:(M)`)],
  ])("refuses a credential file that %s after a successful operation", async (_, reason, change) => {
    const { directory, file, bytes } = await provisioned();
    await change(file);
    await expect(readDeviceHostCredentialFile(directory)).rejects.toThrow(reason);
    await expect(prepareDeviceHostCredentialFile(directory, "host", epoch)).rejects.toThrow(reason);
    expect(launched().map(child => child.exitCode)).toEqual([1, 1]);
    await icacls(file, "/reset");
    expect(await actual.readFile(file)).toEqual(bytes);
  });

  // Windows refuses to resolve a file with no access rules, so the path check fails before its ACL request.
  it("refuses a credential file with no access rules at its path check and stops each operation's child", async () => {
    const { directory, file, bytes } = await provisioned();
    const before = await actual.lstat(file, { bigint: true });
    await icacls(file, "/inheritance:r");
    const { stdout } = await exec(join(system32, "WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$acl = [System.IO.File]::GetAccessControl($env:DOHC_TEST_PATH); '{0} {1} {2}' -f $acl.Access.Count, $acl.AreAccessRulesProtected, $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value"],
    { windowsHide: true, env: { ...process.env, DOHC_TEST_PATH: file } });
    expect(stdout.trim()).toBe(`0 True ${sid}`);
    await expect(readDeviceHostCredentialFile(directory)).rejects.toMatchObject({ code: "EPERM", syscall: "realpath" });
    await expect(prepareDeviceHostCredentialFile(directory, "host", epoch)).rejects.toMatchObject({ code: "EPERM", syscall: "realpath" });
    expect(launched().map(child => [child.exitCode, child.signalCode])).toEqual([[null, "SIGTERM"], [null, "SIGTERM"]]);
    expect(await actual.readdir(directory)).toEqual(["device-host-credential.json"]);
    await icacls(file, "/reset");
    expect(await actual.readFile(file)).toEqual(bytes);
    const after = await actual.lstat(file, { bigint: true });
    expect({ dev: after.dev, ino: after.ino, mtimeNs: after.mtimeNs }).toEqual({ dev: before.dev, ino: before.ino, mtimeNs: before.mtimeNs });
  });

  it("refuses an unprotected credential directory even when every inherited rule is its owner's", async () => {
    const { directory, file, bytes } = await provisioned();
    await icacls(root, "/grant", `*${sid}:(OI)(CI)F`);
    await icacls(root, "/inheritance:r");
    await icacls(directory, "/inheritance:e");
    await expect(readDeviceHostCredentialFile(directory)).rejects.toThrow("Unprotected directory");
    await expect(prepareDeviceHostCredentialFile(directory, "host", epoch)).rejects.toThrow("Unprotected directory");
    expect(launched().map(child => child.exitCode)).toEqual([1, 1]);
    expect(await actual.readFile(file)).toEqual(bytes);
  });

  it("stops its child when a filesystem step fails between checks and keeps temporary cleanup", async () => {
    const directory = join(root, "private"), failure = new Error("injected write failure");
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[1] === "wx") vi.spyOn(handle, "writeFile").mockRejectedValueOnce(failure);
      return handle;
    });
    await expect(prepareDeviceHostCredentialFile(directory, "host", epoch)).rejects.toBe(failure);
    expect(await actual.readdir(directory)).toEqual([]);
    const children = launched();
    expect(children).toHaveLength(1);
    expect([children[0]!.exitCode, children[0]!.signalCode]).not.toEqual([null, null]);
    expect(children[0]!.exitCode).not.toBe(0);
  });
});
