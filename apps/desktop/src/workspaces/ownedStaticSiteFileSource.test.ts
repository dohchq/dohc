import { describe, expect, it, vi } from "vitest";
import { createOwnedStaticSiteFileSource } from "./ownedStaticSiteFileSource";

describe("createOwnedStaticSiteFileSource", () => {
  it("binds allowed requests to one explicit owner target and root", async () => {
    const target = {
      kind: "mount" as const,
      workspaceId: "host",
      shareId: "share",
    };
    const read = vi.fn(async () => Buffer.from("owner bytes"));
    const source = createOwnedStaticSiteFileSource({
      servedPaths: ["index.html", "assets/app.js"],
      target,
      ownerRootPath: "site/dist",
      read,
    });

    expect(source.contains("index.html")).toBe(true);
    expect(source.contains("recipient-only.js")).toBe(false);
    await expect(source.read("assets/app.js")).resolves.toEqual(
      Buffer.from("owner bytes"),
    );
    expect(read).toHaveBeenCalledWith(target, "site/dist/assets/app.js");
    await expect(source.read("recipient-only.js")).rejects.toThrow(
      /unavailable/i,
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not add a dot segment for a standalone owner root", async () => {
    const read = vi.fn(async () => new Uint8Array());
    const target = { kind: "standalone" as const, workspaceId: "shared" };
    const source = createOwnedStaticSiteFileSource({
      servedPaths: ["index.html"],
      target,
      ownerRootPath: ".",
      read,
    });

    await source.read("index.html");
    expect(read).toHaveBeenCalledWith(target, "index.html");
  });
});
