import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicCreateFile } from "../atomicReplaceFile";
import { SECRET_KEY_RELATIVE_PATH, installWorkspaceDataKey } from "./workspaceDataKey";
import { createTestScratch } from "./testTemp";

vi.mock("../atomicReplaceFile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../atomicReplaceFile")>();
  return { ...actual, atomicCreateFile: vi.fn(actual.atomicCreateFile) };
});
const actual = await vi.importActual<typeof import("../atomicReplaceFile")>("../atomicReplaceFile");
afterEach(() => vi.mocked(atomicCreateFile).mockReset());

const generalWords = "The workspace secret key file could not be installed.";
const keyFile = (fill: number) => `dohc-secret-key-v1:${Buffer.alloc(32, fill).toString("base64")}\n`;

async function keyFolder(): Promise<{ root: string; path: string }> {
  const root = await createTestScratch("dohc-key-install-");
  const path = join(root, SECRET_KEY_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true });
  return { root, path };
}

function failLinks(code: string, errno: number, before?: (destination: string) => Promise<void>) {
  const link = vi.fn(async (_source: string, destination: string) => {
    await before?.(destination);
    throw Object.assign(new Error("link failed"), { code, errno, syscall: "link" });
  });
  vi.mocked(atomicCreateFile).mockImplementationOnce((destination, data, mode, options) =>
    actual.atomicCreateFile(destination, data, mode, { ...options, link }),
  );
  return link;
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
  ] as const)("writes the key in place only on a drive without hard links: %s", async (code, errno, inPlace) => {
    const { root, path } = await keyFolder();
    const link = failLinks(code, errno);
    const installed = onPlatform(platform, () => installWorkspaceDataKey(root, Buffer.alloc(32, 7)));
    if (inPlace) {
      await installed;
      expect(await readFile(path, "utf8")).toBe(keyFile(7));
      expect(await readdir(dirname(path))).toEqual(["secret.key"]);
    } else {
      await expect(installed).rejects.toMatchObject({ name: "SecretFileStoreError", code: "key-corrupt", message: generalWords });
      expect(await readdir(dirname(path))).toEqual([]);
    }
    expect(link).toHaveBeenCalledOnce();
  });
});

it("writes the key in place readable only by its owner", async () => {
  const { root, path } = await keyFolder();
  failLinks("ENOTSUP", -4049);
  await installWorkspaceDataKey(root, Buffer.alloc(32, 7));
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("keeps a different key that appears while the key is written in place", async () => {
  const { root, path } = await keyFolder();
  failLinks("ENOTSUP", -4049, destination => writeFile(destination, keyFile(9)));
  await expect(installWorkspaceDataKey(root, Buffer.alloc(32, 7))).rejects.toMatchObject({
    code: "key-corrupt",
    message: "A different workspace secret key already exists locally; refusing to overwrite protected state.",
  });
  expect(await readFile(path, "utf8")).toBe(keyFile(9));
  expect(await readdir(dirname(path))).toEqual(["secret.key"]);
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
