import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipcWireError, PRIVACY_DENIED_WORDS, readError } from "../ipc/errorWords";
import { assertRootNotPrivacyDenied, isPrivacyDenial, withPrivacyDenial } from "./privacyDenial";

vi.mock("node:fs", async (actual) => {
  const real = await actual<typeof import("node:fs")>();
  return { ...real, accessSync: vi.fn(real.accessSync) };
});
vi.mock("node:fs/promises", async (actual) => {
  const real = await actual<typeof import("node:fs/promises")>();
  return { ...real, opendir: vi.fn(real.opendir) };
});

function errno(code: string, path?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, open '${path ?? ""}'`), {
    code, ...(path === undefined ? {} : { path }),
  });
}

// What a macOS privacy refusal does to every call on the folder: the read
// check fails with EPERM too.
function refuseReads(): void {
  vi.mocked(fs.accessSync).mockImplementation(() => { throw errno("EPERM", "/Users/me/Documents/Trip"); });
}

describe("macOS privacy refusals", () => {
  // Back to the real calls: a Finder lock below needs them.
  afterEach(() => { vi.mocked(fs.accessSync).mockReset(); vi.mocked(fsPromises.opendir).mockReset(); });

  it("names an EPERM that also refuses reads, on macOS only", () => {
    refuseReads();
    const error = errno("EPERM", "/Users/me/Documents/Trip/notes.md");
    expect(isPrivacyDenial(error, "darwin")).toBe(true);
    expect(isPrivacyDenial(error, "linux")).toBe(false);
    expect(isPrivacyDenial(error, "win32")).toBe(false);
    expect(isPrivacyDenial(errno("EACCES", "/Users/me/Documents/Trip/notes.md"), "darwin")).toBe(false);
    // A worker hands back the message alone.
    expect(isPrivacyDenial(new Error("EPERM: operation not permitted, scandir '/Users/me/Documents/Trip'"), "darwin")).toBe(true);
  });

  it.runIf(process.platform === "darwin")("keeps a file locked in Finder apart: it refuses writes and still reads", () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "dohc-privacy-"));
    const file = join(dir, "locked.md");
    fs.writeFileSync(file, "# Locked\n");
    execFileSync("chflags", ["uchg", file]);
    try {
      let refused: unknown;
      try { fs.writeFileSync(file, "# Changed\n"); } catch (error) { refused = error; }
      expect((refused as NodeJS.ErrnoException).code).toBe("EPERM");
      expect(isPrivacyDenial(refused, "darwin")).toBe(false);
      expect(withPrivacyDenial(refused, "darwin")).toBe(refused);
    } finally {
      execFileSync("chflags", ["nouchg", file]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("crosses the IPC boundary as words a person can act on, keeping the error for Copy details", () => {
    refuseReads();
    const error = errno("EPERM", "/Users/me/Documents/Trip");
    const wire = String(ipcWireError(withPrivacyDenial(error, "darwin")));
    expect(readError(`Error invoking remote method 'desktop:open-workspace': ${wire}`)).toEqual({
      words: PRIVACY_DENIED_WORDS,
      mapped: true,
      cause: `Error [privacy-denied]: ${error.message}`,
    });
    expect(withPrivacyDenial(error, "linux")).toBe(error);
  });

  it("fails a macOS open whose root refuses reads, and leaves any other answer to the open", async () => {
    refuseReads();
    vi.mocked(fsPromises.opendir).mockRejectedValueOnce(errno("EPERM", "/Users/me/Documents/Trip"));
    await expect(assertRootNotPrivacyDenied("/Users/me/Documents/Trip", "darwin")).rejects.toMatchObject({ code: "EPERM" });

    vi.mocked(fsPromises.opendir).mockRejectedValueOnce(errno("ENOENT", "/Users/me/Documents/Gone"));
    await expect(assertRootNotPrivacyDenied("/Users/me/Documents/Gone", "darwin")).resolves.toBeUndefined();

    await expect(assertRootNotPrivacyDenied("/Users/me/Documents/Trip", "linux")).resolves.toBeUndefined();
    expect(fsPromises.opendir).toHaveBeenCalledTimes(2);
  });
});
