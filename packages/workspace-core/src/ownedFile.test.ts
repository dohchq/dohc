import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readOwnedFile } from "./ownedFile";

// The size the next opened handle reports, as a file that grew after it.
const seam = vi.hoisted(() => ({ size: null as number | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const size = seam.size;
      seam.size = null;
      if (size === null) return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === "stat") {
            return async () => {
              const stats = await target.stat();
              return Object.assign(Object.create(Object.getPrototypeOf(stats) as object) as typeof stats, stats, { size });
            };
          }
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function folder() {
  const path = await mkdtemp(join(tmpdir(), "dohc-owned-file-"));
  folders.push(path);
  return path;
}

describe("readOwnedFile", () => {
  it("reads a file of this user's whole, even one that grew after its size was read", async () => {
    const path = join(await folder(), "state.json");
    await writeFile(path, "0123456789", { mode: 0o600 });
    await expect(readOwnedFile(path, 10)).resolves.toEqual({ status: "read", content: "0123456789" });
    seam.size = 1;
    await expect(readOwnedFile(path, 100)).resolves.toEqual({ status: "read", content: "0123456789" });
    await writeFile(path, "", { mode: 0o600 });
    await expect(readOwnedFile(path, 10)).resolves.toEqual({ status: "read", content: "" });
  });

  it("refuses a file larger than the cap, also when it grew past it after its size was read", async () => {
    const path = join(await folder(), "state.json");
    await writeFile(path, "0123456789", { mode: 0o600 });
    await expect(readOwnedFile(path, 9)).resolves.toEqual({ status: "too-large" });
    seam.size = 1;
    await expect(readOwnedFile(path, 5)).resolves.toEqual({ status: "too-large" });
    // The size the handle reports is checked before anything is read.
    seam.size = 100;
    await expect(readOwnedFile(path, 50)).resolves.toEqual({ status: "too-large" });
  });

  it("tells a missing file from one it does not trust", async () => {
    const root = await folder();
    await expect(readOwnedFile(join(root, "absent.json"), 10)).resolves.toEqual({ status: "missing" });
    await mkdir(join(root, "folder"));
    await expect(readOwnedFile(join(root, "folder"), 10)).resolves.toEqual({ status: "not-file" });
    const path = join(root, "state.json");
    await writeFile(path, "{}", { mode: 0o600 });
    await symlink(path, join(root, "link.json"));
    await expect(readOwnedFile(join(root, "link.json"), 10)).resolves.toEqual({ status: "not-file" });
    await link(path, join(root, "second.json"));
    await expect(readOwnedFile(path, 10)).resolves.toEqual({ status: "linked" });
  });

  // Node reports no owner or mode on Windows.
  it.skipIf(process.platform === "win32")("refuses a file other users can write or another user owns", async () => {
    const path = join(await folder(), "state.json");
    await writeFile(path, "{}", { mode: 0o600 });
    await chmod(path, 0o620);
    await expect(readOwnedFile(path, 10)).resolves.toEqual({ status: "writable-by-others" });
    await chmod(path, 0o600);
    const someoneElse = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    try {
      await expect(readOwnedFile(path, 10)).resolves.toEqual({ status: "other-owner" });
    } finally {
      someoneElse.mockRestore();
    }
  });
});
