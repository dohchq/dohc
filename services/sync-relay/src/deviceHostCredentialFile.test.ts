import { link, lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { createDeviceHostCredential } from "./deviceHostCredential.js";
import { prepareDeviceHostCredentialFile } from "./deviceHostCredentialFile.js";

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
