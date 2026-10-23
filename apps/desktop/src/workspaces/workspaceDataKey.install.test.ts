import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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

it.each([
  ["ENOTSUP", -4049, true],
  ["ENOSYS", -4054, true],
  ["EISDIR", -4068, process.platform === "win32"],
  ["EPERM", -4048, false],
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

  await expect(installWorkspaceDataKey(root, Buffer.alloc(32, 7))).rejects.toMatchObject({
    name: "SecretFileStoreError",
    code: unsupported ? "key-install-unsupported" : "key-corrupt",
    message: unsupported ? unsupportedWords : generalWords,
  });
  expect(link).toHaveBeenCalledOnce();
  // No direct key write, and no incomplete temporary key left behind.
  expect(await readdir(dirname(path))).toEqual([]);
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
