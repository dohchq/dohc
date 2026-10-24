import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicCreateFile } from "../atomicReplaceFile";
import { SECRET_KEY_RELATIVE_PATH, installWorkspaceDataKey } from "./workspaceDataKey";
import { createTestScratch } from "./testTemp";

// A drive's hard links, and the rename that replaces them where it has none.
// `events` records each read and each flush of a file or folder, in order.
const drive = vi.hoisted(() => ({
  link: null as null | { code: string; errno: number; before?: (source: string, destination: string) => Promise<void> },
  renameFails: false,
  afterFlush: null as null | (() => Promise<void>),
  events: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    link: async (source: string, destination: string) => {
      if (!drive.link) return fs.link(source, destination);
      await drive.link.before?.(source, destination);
      throw Object.assign(new Error("link failed"), { code: drive.link.code, errno: drive.link.errno, syscall: "link" });
    },
    rename: async (source: string, destination: string) => {
      if (drive.renameFails) throw Object.assign(new Error("rename failed"), { code: "EIO", syscall: "rename" });
      return fs.rename(source, destination);
    },
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      drive.events.push("read");
      return fs.readFile(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (args[1] !== "r") return handle;
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        drive.events.push(`flush ${basename(String(args[0]))}`);
        const after = drive.afterFlush;
        drive.afterFlush = null;
        await after?.();
      };
      return handle;
    },
  };
});
vi.mock("../atomicReplaceFile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../atomicReplaceFile")>();
  return { ...actual, atomicCreateFile: vi.fn(actual.atomicCreateFile) };
});
const actual = await vi.importActual<typeof import("../atomicReplaceFile")>("../atomicReplaceFile");
afterEach(() => {
  vi.mocked(atomicCreateFile).mockReset();
  drive.link = null;
  drive.renameFails = false;
  drive.afterFlush = null;
  drive.events = [];
});

const unsupportedWords =
  "This drive can't store the workspace's secret key safely. Move the workspace to an NTFS, APFS or ext4 drive, then try again.";
const generalWords = "The workspace secret key file could not be installed.";
const keyFile = (fill: number) => `dohc-secret-key-v1:${Buffer.alloc(32, fill).toString("base64")}\n`;

async function keyFolder(): Promise<{ root: string; path: string }> {
  const root = await createTestScratch("dohc-key-install-");
  const path = join(root, SECRET_KEY_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true });
  return { root, path };
}

async function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    return await run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

// Faking another Unix on Windows would still meet Windows file modes and folders.
const platforms: NodeJS.Platform[] = process.platform === "win32" ? ["win32"] : ["win32", process.platform];
describe.each(platforms)("key publication on %s", platform => {
  it.each([
    ["ENOTSUP", -4049, true],
    ["ENOSYS", -4054, true],
    ["EISDIR", -4068, platform === "win32"],
    ["EPERM", -4048, platform !== "win32"],
    ["EOPNOTSUPP", -95, platform !== "win32"],
    ["EACCES", -4092, false],
    ["EXDEV", -4037, false],
    ["EIO", -4070, false],
  ] as const)("handles a failed hard link: %s", async (code, errno, unsupported) => {
    const { root, path } = await keyFolder();
    drive.link = { code, errno };
    const installed = onPlatform(platform, () => installWorkspaceDataKey(root, Buffer.alloc(32, 7)));
    if (unsupported && platform !== "win32") {
      await installed;
      expect(await readFile(path, "utf8")).toBe(keyFile(7));
      expect(await readdir(dirname(path))).toEqual(["secret.key"]);
      return;
    }
    await expect(installed).rejects.toMatchObject({
      name: "SecretFileStoreError",
      code: unsupported ? "key-install-unsupported" : "key-corrupt",
      message: unsupported ? unsupportedWords : generalWords,
    });
    // No key, claim or temporary file is left behind.
    expect(await readdir(dirname(path))).toEqual([]);
  });
});

describe.runIf(process.platform !== "win32")("on a drive without hard links", () => {
  it("publishes and flushes the key readable only by its owner", async () => {
    const { root, path } = await keyFolder();
    drive.link = { code: "ENOTSUP", errno: -4049 };
    await installWorkspaceDataKey(root, Buffer.alloc(32, 7));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(drive.events.slice(-2)).toEqual(["flush secret.key", "flush engine"]);
  });

  it("keeps a different key that claims the name first", async () => {
    const { root, path } = await keyFolder();
    drive.link = { code: "ENOTSUP", errno: -4049, before: (_, destination) => writeFile(destination, keyFile(9)) };
    await expect(installWorkspaceDataKey(root, Buffer.alloc(32, 7))).rejects.toMatchObject({
      code: "key-corrupt",
      message: "A different workspace secret key already exists locally; refusing to overwrite protected state.",
    });
    expect(await readFile(path, "utf8")).toBe(keyFile(9));
    expect(await readdir(dirname(path))).toEqual(["secret.key"]);
  });

  it("refuses a drive that lets other users read the key", async () => {
    const { root, path } = await keyFolder();
    drive.link = { code: "ENOTSUP", errno: -4049, before: source => chmod(source, 0o644) };
    await expect(installWorkspaceDataKey(root, Buffer.alloc(32, 7))).rejects.toMatchObject({
      code: "key-install-unsupported",
      message: unsupportedWords,
    });
    expect(await readdir(dirname(path))).toEqual([]);
  });

  it("flushes the folder after reading a key renamed over the claim it lost", async () => {
    const { root, path } = await keyFolder();
    // Another creator holds the claim, and renames the same key over it after this one's flush.
    drive.link = { code: "ENOTSUP", errno: -4049, before: (_, destination) => writeFile(destination, "") };
    drive.afterFlush = () => writeFile(path, keyFile(7));
    await installWorkspaceDataKey(root, Buffer.alloc(32, 7));
    expect(drive.events.slice(drive.events.lastIndexOf("read"))).toEqual(["read", "flush secret.key", "flush engine"]);
  });

  it("removes its empty claim when the rename over it fails", async () => {
    const { root, path } = await keyFolder();
    drive.link = { code: "ENOTSUP", errno: -4049 };
    drive.renameFails = true;
    await expect(installWorkspaceDataKey(root, Buffer.alloc(32, 7))).rejects.toMatchObject({ code: "key-corrupt", message: generalWords });
    expect(await readdir(dirname(path))).toEqual([]);
  });
});

it("keeps the general words when the temporary file cannot be opened", async () => {
  const { root, path } = await keyFolder();
  vi.mocked(atomicCreateFile).mockImplementationOnce((destination, data, mode) =>
    actual.atomicCreateFile(destination, data, mode, {
      open: async () => {
        throw Object.assign(new Error("open unsupported"), { code: "ENOTSUP", syscall: "open" });
      },
    }),
  );
  await expect(installWorkspaceDataKey(root, Buffer.alloc(32, 7))).rejects.toMatchObject({
    code: "key-corrupt",
    message: generalWords,
  });
  expect(await readdir(dirname(path))).toEqual([]);
});
