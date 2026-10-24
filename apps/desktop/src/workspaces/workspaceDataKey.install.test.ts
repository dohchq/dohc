import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicCreateFile } from "../atomicReplaceFile";
import { SECRET_KEY_RELATIVE_PATH, installWorkspaceDataKey } from "./workspaceDataKey";
import { createTestScratch } from "./testTemp";

// A drive's hard links, and the rename that replaces them where it has none.
const drive = vi.hoisted(() => ({
  link: null as null | { code: string; errno: number; before?: (source: string, destination: string) => Promise<void> },
  renameFails: false,
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

describe.each(["win32", "linux", "darwin"] as const)("key publication on %s", platform => {
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
  it("publishes the key readable only by its owner", async () => {
    const { root, path } = await keyFolder();
    drive.link = { code: "ENOTSUP", errno: -4049 };
    await installWorkspaceDataKey(root, Buffer.alloc(32, 7));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
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
