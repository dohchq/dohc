import { mkdir, readdir } from "node:fs/promises";
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

const unsupportedWords =
  "This drive can't store the workspace's secret key safely. Move the workspace to an NTFS, APFS or ext4 drive, then try again.";
const generalWords = "The workspace secret key file could not be installed.";

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
  ] as const)("explains a failed key publication: %s", async (code, errno, unsupported) => {
    const root = await createTestScratch("dohc-key-install-refusal-");
    const path = join(root, SECRET_KEY_RELATIVE_PATH);
    await mkdir(dirname(path), { recursive: true });
    const link = vi.fn(async () => {
      throw Object.assign(new Error("link failed"), { code, errno, syscall: "link" });
    });
    vi.mocked(atomicCreateFile).mockImplementationOnce((destination, data, mode) =>
      actual.atomicCreateFile(destination, data, mode, { link }),
    );

    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { ...descriptor, value: platform });
      await expect(installWorkspaceDataKey(root, Buffer.alloc(32, 7))).rejects.toMatchObject({
        name: "SecretFileStoreError",
        code: unsupported ? "key-install-unsupported" : "key-corrupt",
        message: unsupported ? unsupportedWords : generalWords,
      });
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
    expect(link).toHaveBeenCalledOnce();
    // No direct key write, and no incomplete temporary key left behind.
    expect(await readdir(dirname(path))).toEqual([]);
  });
});

it("keeps the general words when the temporary file cannot be opened", async () => {
  const root = await createTestScratch("dohc-key-install-refusal-");
  const path = join(root, SECRET_KEY_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true });
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
