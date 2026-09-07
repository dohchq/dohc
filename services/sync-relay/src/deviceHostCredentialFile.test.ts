import { link, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { createDeviceHostCredential } from "./deviceHostCredential.js";
import { DeviceHostCredentialFileUnavailable, prepareDeviceHostCredentialFile, readDeviceHostCredentialFile } from "./deviceHostCredentialFile.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link), lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});
vi.mock("./deviceHostCredential.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./deviceHostCredential.js")>();
  return { ...actual, createDeviceHostCredential: vi.fn(actual.createDeviceHostCredential) };
});

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const epoch = parseHostEpoch(1);
let root: string;
beforeEach(async () => {
  const scratch = fileURLToPath(new URL("../.output/", import.meta.url));
  await actual.mkdir(scratch, { recursive: true });
  root = await actual.mkdtemp(join(scratch, "credential-file-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(link).mockReset(); vi.mocked(lstat).mockReset(); vi.mocked(open).mockReset();
  vi.mocked(createDeviceHostCredential).mockClear();
  if (root) await actual.rm(root, { recursive: true, force: true });
});

function paths() {
  const directory = join(root, "private");
  return { directory, final: join(directory, "device-host-credential.json") };
}

it("refuses unvalidated Darwin ACLs before creating credential paths", async () => {
  const { directory } = paths();
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  await expect(prepareDeviceHostCredentialFile(directory, "host", epoch)).rejects.toThrow(
    "Device host credential files are unavailable on macOS because ACL validation is not implemented.",
  );
  await expect(actual.lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses to read a copied credential on Darwin before inspecting paths", async () => {
  const { directory, final } = paths();
  await actual.mkdir(directory, { mode: 0o700 });
  await actual.writeFile(final, JSON.stringify(createDeviceHostCredential("host", epoch)), { mode: 0o600 });
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  await expect(readDeviceHostCredentialFile(directory)).rejects.toBeInstanceOf(DeviceHostCredentialFileUnavailable);
  expect(lstat).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

it.skipIf(process.platform === "darwin")("checks a new file before writing secrets, removes it on refusal, and retries with a fresh secret", async () => {
  const { directory, final } = paths();
  let createdPath: string | undefined, bytesAtCheck: number | undefined;
  const failure = new Error("injected privacy refusal");
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[1] === "wx") createdPath = String(args[0]);
    return handle;
  });
  vi.mocked(lstat).mockImplementation((async (path: Parameters<typeof lstat>[0], options?: Parameters<typeof lstat>[1]) => {
    const stat = await actual.lstat(path, options);
    if (String(path) === createdPath && bytesAtCheck === undefined) {
      bytesAtCheck = (await actual.readFile(path)).length;
      await actual.writeFile(join(directory, "operator-note"), "keep");
      throw failure;
    }
    return stat;
  }) as typeof lstat);
  await expect(prepareDeviceHostCredentialFile(directory, "host", epoch)).rejects.toBe(failure);
  expect(bytesAtCheck).toBe(0);
  await expect(actual.lstat(createdPath!)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(actual.lstat(final)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await actual.readFile(join(directory, "operator-note"), "utf8")).toBe("keep");
  const refused = vi.mocked(createDeviceHostCredential).mock.results[0]!.value;
  vi.mocked(lstat).mockReset();
  const retry = await prepareDeviceHostCredentialFile(directory, "host", epoch);
  expect(retry.secret === refused.secret).toBe(false);
  expect(await prepareDeviceHostCredentialFile(directory, "host", epoch)).toEqual(retry);
});

it.skipIf(process.platform === "darwin")("keeps an interrupted partial write away from the final path and permits retry", async () => {
  const { directory, final } = paths();
  const failure = new Error("injected partial write");
  let interrupted = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[1] === "wx" && !interrupted) {
      interrupted = true;
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => { await write("{"); throw failure; });
    }
    return handle;
  });
  await expect(prepareDeviceHostCredentialFile(directory, "host", epoch)).rejects.toBe(failure);
  await expect(actual.lstat(final)).rejects.toMatchObject({ code: "ENOENT" });
  const retry = await prepareDeviceHostCredentialFile(directory, "host", epoch);
  expect(JSON.parse(await actual.readFile(final, "utf8"))).toEqual(retry);
});

it.skipIf(process.platform === "darwin")("publishes only synced complete bytes and ignores private crash residue on retry", async () => {
  const { directory, final } = paths();
  let synced = false, published = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[1] === "wx") {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); synced = true; });
    }
    return handle;
  });
  vi.mocked(link).mockImplementation(async (source, destination) => {
    expect(synced).toBe(true);
    await expect(actual.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await actual.readFile(source, "utf8"))).toMatchObject({ hostId: "host" });
    await actual.link(source, destination);
    published = true;
  });
  const credential = await prepareDeviceHostCredentialFile(directory, "host", epoch);
  expect(published).toBe(true);
  await actual.unlink(final);
  const residue = join(directory, ".device-host-credential-interrupted.tmp");
  await actual.writeFile(residue, "{", { mode: 0o600 });
  const retry = await prepareDeviceHostCredentialFile(directory, "host", epoch);
  expect(retry.secret === credential.secret).toBe(false);
  expect(await actual.readFile(residue, "utf8")).toBe("{");
});

it.skipIf(process.platform === "darwin")("does not overwrite a final path created before publication", async () => {
  const { directory, final } = paths();
  vi.mocked(link).mockImplementationOnce(async (source, destination) => {
    await actual.writeFile(destination, "operator replacement", { flag: "wx", mode: 0o600 });
    await actual.link(source, destination);
  });
  await expect(prepareDeviceHostCredentialFile(directory, "host", epoch)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await actual.readFile(final, "utf8")).toBe("operator replacement");
  expect(await actual.readdir(directory)).toEqual(["device-host-credential.json"]);
});

it.skipIf(process.platform === "darwin")("leaves a replacement path untouched when new-file validation fails", async () => {
  const { directory } = paths();
  let createdPath: string | undefined, replaced = false;
  const held = join(root, "held-empty-file"), failure = new Error("injected replacement refusal");
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[1] === "wx") createdPath = String(args[0]);
    return handle;
  });
  vi.mocked(lstat).mockImplementation((async (path: Parameters<typeof lstat>[0], options?: Parameters<typeof lstat>[1]) => {
    const stat = await actual.lstat(path, options);
    if (String(path) === createdPath && !replaced) {
      replaced = true;
      await actual.rename(path, held);
      await actual.writeFile(path, "operator replacement", { flag: "wx" });
      throw failure;
    }
    return stat;
  }) as typeof lstat);
  await expect(prepareDeviceHostCredentialFile(directory, "host", epoch)).rejects.toBe(failure);
  expect((await actual.readFile(held)).length).toBe(0);
  expect(await actual.readFile(createdPath!, "utf8")).toBe("operator replacement");
});

it.skipIf(process.platform === "darwin")("syncs the published name after linking and before returning", async () => {
  const { directory } = paths(), events: string[] = [];
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      await sync(); events.push(args[1] === "wx" ? "file sync" : "directory sync");
    });
    return handle;
  });
  vi.mocked(link).mockImplementation(async (...args) => { await actual.link(...args); events.push("published"); });
  await prepareDeviceHostCredentialFile(directory, "host", epoch);
  expect(events).toEqual(process.platform === "win32" ? ["file sync", "published", "file sync"] :
    ["file sync", "published", "file sync", "directory sync"]);
});

it.skipIf(process.platform === "darwin")("retries through one existing-only writable handle without changing bytes or identity", async () => {
  const { directory, final } = paths();
  const credential = await prepareDeviceHostCredentialFile(directory, "host", epoch);
  const before = await actual.readFile(final), identity = await actual.lstat(final, { bigint: true });
  const events: string[] = [];
  let validated = false;
  vi.mocked(lstat).mockImplementation((async (...args: Parameters<typeof lstat>) => {
    const stat = await actual.lstat(...args);
    if (String(args[0]) === final && stat.isFile()) validated = true;
    return stat;
  }) as typeof lstat);
  vi.mocked(open).mockImplementation(async (...args) => {
    if (String(args[0]) === final) { expect(validated).toBe(true); expect(args[1]).toBe("r+"); }
    const handle = await actual.open(...args);
    if (String(args[0]) === final) {
      const read = handle.readFile.bind(handle), sync = handle.sync.bind(handle);
      vi.spyOn(handle, "readFile").mockImplementation(async (...readArgs) => { events.push("read"); return read(...readArgs); });
      vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); events.push("file sync"); });
      for (const method of ["writeFile", "truncate", "chmod"] as const) vi.spyOn(handle, method).mockImplementation(async () => { throw new Error("Existing credential mutation"); });
    } else {
      expect(String(args[0])).toBe(directory); expect(args[1]).toBe("r");
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); events.push("directory sync"); });
    }
    return handle;
  });
  expect(await prepareDeviceHostCredentialFile(directory, "host", epoch)).toEqual(credential);
  expect(events).toEqual(process.platform === "win32" ? ["read", "file sync"] : ["read", "file sync", "directory sync"]);
  expect(await actual.readFile(final)).toEqual(before);
  const after = await actual.lstat(final, { bigint: true });
  expect({ dev: after.dev, ino: after.ino, mode: after.mode, mtimeNs: after.mtimeNs }).toEqual(
    { dev: identity.dev, ino: identity.ino, mode: identity.mode, mtimeNs: identity.mtimeNs });
});

it.skipIf(process.platform === "darwin")("refuses an existing file replaced after privacy validation before reading or syncing", async () => {
  const { directory, final } = paths();
  await prepareDeviceHostCredentialFile(directory, "host", epoch);
  const before = await actual.readFile(final), held = join(directory, "held-original");
  let read = false, synced = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    if (String(args[0]) === final) {
      await actual.rename(final, held); await actual.writeFile(final, before, { flag: "wx", mode: 0o600 });
    }
    const handle = await actual.open(...args);
    if (String(args[0]) === final) {
      const originalRead = handle.readFile.bind(handle), sync = handle.sync.bind(handle);
      vi.spyOn(handle, "readFile").mockImplementation(async (...readArgs) => { read = true; return originalRead(...readArgs); });
      vi.spyOn(handle, "sync").mockImplementation(async () => { synced = true; await sync(); });
    }
    return handle;
  });
  await expect(prepareDeviceHostCredentialFile(directory, "host", epoch)).rejects.toThrow("Credential file changed.");
  expect(read).toBe(false); expect(synced).toBe(false);
  expect(await actual.readFile(final)).toEqual(before); expect(await actual.readFile(held)).toEqual(before);
});

it.skipIf(process.platform === "darwin")("refuses a read-only credential replaced between validation and opening", async () => {
  const { directory, final } = paths();
  await prepareDeviceHostCredentialFile(directory, "host", epoch);
  const before = await actual.readFile(final), held = join(directory, "held-original");
  let read = false, closed = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    expect(String(args[0])).toBe(final); expect(args[1]).toBe("r");
    await actual.rename(final, held);
    await actual.writeFile(final, before, { flag: "wx", mode: 0o600 });
    const handle = await actual.open(...args);
    const originalRead = handle.readFile.bind(handle), close = handle.close.bind(handle);
    vi.spyOn(handle, "readFile").mockImplementation(async (...readArgs) => { read = true; return originalRead(...readArgs); });
    vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed = true; });
    for (const method of ["writeFile", "truncate", "chmod", "sync"] as const) vi.spyOn(handle, method).mockImplementation(async () => { throw new Error("Read-only credential mutation"); });
    return handle;
  });
  await expect(readDeviceHostCredentialFile(directory)).rejects.toThrow("Credential file changed.");
  expect(read).toBe(false); expect(closed).toBe(true);
  expect(await actual.readFile(final)).toEqual(before); expect(await actual.readFile(held)).toEqual(before);
});

it.skipIf(process.platform === "win32" || process.platform === "darwin")("repeats a failed directory sync on an existing-file retry", async () => {
  const { directory, final } = paths();
  await prepareDeviceHostCredentialFile(directory, "host", epoch);
  const before = await actual.readFile(final), failure = new Error("injected parent sync failure");
  let attempts = 0;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (String(args[0]) === directory) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => { attempts++; if (attempts === 1) throw failure; await sync(); });
    }
    return handle;
  });
  await expect(prepareDeviceHostCredentialFile(directory, "host", epoch)).rejects.toBe(failure);
  await prepareDeviceHostCredentialFile(directory, "host", epoch);
  expect(attempts).toBe(2); expect(await actual.readFile(final)).toEqual(before);
});
