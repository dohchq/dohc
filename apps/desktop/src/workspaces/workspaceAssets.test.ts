import { mkdtemp, mkdir, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mediaTypeForExtension,
  readWorkspaceAsset,
  readWorkspaceText,
  resolveWorkspaceFile,
  writeWorkspaceText,
} from "./workspaceAssets";

// The asset/text serving path is the renderer's ONLY window into workspace
// bytes, so its negative paths are security boundaries: traversal and symlink
// escapes must be refused, and the size caps must hold (one oversized file
// must never freeze the main process or stream unbounded bytes over IPC).

async function makeWorkspace(): Promise<string> {
  const root = join(await mkdtemp(join(tmpdir(), "dohc-assets-")), "ws");
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "a.md"), "# A\n");
  return root;
}

describe("resolveWorkspaceFile containment", () => {
  it("resolves an in-workspace path and refuses traversal/absolute/reserved", async () => {
    const root = await makeWorkspace();
    const ok = await resolveWorkspaceFile(root, "notes/a.md");
    expect(ok.normalized).toBe("notes/a.md");
    for (const evil of ["../outside.md", "/etc/passwd", ".dohc/manifest.json", "%2e%2e/x"]) {
      await expect(resolveWorkspaceFile(root, evil)).rejects.toThrow(/Invalid asset path/);
    }
  });

  it("refuses a symlink that points outside the workspace (real-path containment)", async () => {
    const root = await makeWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "dohc-assets-outside-"));
    await writeFile(join(outside, "secret.txt"), "top secret");
    await symlink(join(outside, "secret.txt"), join(root, "notes", "link.txt"));
    await expect(resolveWorkspaceFile(root, "notes/link.txt")).rejects.toThrow(
      /escapes workspace/,
    );
    // And the read paths built on it refuse too — nothing leaks via media/text.
    await expect(readWorkspaceAsset(root, "notes/link.txt")).rejects.toThrow(/escapes workspace/);
    await expect(readWorkspaceText(root, "notes/link.txt")).rejects.toThrow(/escapes workspace/);
  });
});

describe("size caps", () => {
  it("refuses to serve an asset above the 64MB cap (sparse file, no real bytes written)", async () => {
    const root = await makeWorkspace();
    const big = join(root, "notes", "huge.png");
    await writeFile(big, "");
    await truncate(big, 64 * 1024 * 1024 + 1);
    await expect(readWorkspaceAsset(root, "notes/huge.png")).rejects.toThrow(/too large to serve/);
  });

  it("refuses an editor write above the 2MB text cap before touching the file", async () => {
    const root = await makeWorkspace();
    await expect(
      writeWorkspaceText(root, "notes/a.md", "x".repeat(2 * 1024 * 1024 + 1)),
    ).rejects.toThrow(/editor limit/);
    // The file is untouched by the refused write.
    expect(await readFile(join(root, "notes", "a.md"), "utf8")).toBe("# A\n");
  });

  it("bounded text read truncates instead of buffering an oversized file", async () => {
    const root = await makeWorkspace();
    const big = join(root, "notes", "big.md");
    await writeFile(big, "y".repeat(2 * 1024 * 1024 + 10));
    const result = await readWorkspaceText(root, "notes/big.md");
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(2 * 1024 * 1024);
  });
});

describe("writeWorkspaceText atomicity + round trip", () => {
  it("writes atomically and reads back exactly what was written", async () => {
    const root = await makeWorkspace();
    await writeWorkspaceText(root, "notes/a.md", "# Edited\n");
    expect(await readFile(join(root, "notes", "a.md"), "utf8")).toBe("# Edited\n");
    const back = await readWorkspaceText(root, "notes/a.md");
    expect(back).toEqual({ text: "# Edited\n", truncated: false });
  });
});

describe("mediaTypeForExtension", () => {
  it("maps known media types and falls back to octet-stream (never executable)", () => {
    expect(mediaTypeForExtension("a/b.png")).toBe("image/png");
    expect(mediaTypeForExtension("x.PDF")).toBe("application/pdf");
    expect(mediaTypeForExtension("voice.m4a")).toBe("audio/mp4");
    expect(mediaTypeForExtension("app.html")).toBe("application/octet-stream");
    expect(mediaTypeForExtension("script.js")).toBe("application/octet-stream");
  });
});
