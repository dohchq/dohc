import { describe, expect, it } from "vitest";
import { createAccountlessPathProjection } from "./accountlessPathProjection";

describe("accountless path projection", () => {
  it("projects every served path field without mutating the real selector", () => {
    const selector = {
      paths: ["clients/acme/private/docs"],
      versionId: "snapshot-1",
      access: "view" as const,
    };
    const projection = createAccountlessPathProjection(selector);
    const realPath = "clients/acme/private/docs/guides/start.md";

    expect(projection.selector.paths).toEqual(["docs"]);
    expect(selector.paths).toEqual(["clients/acme/private/docs"]);
    expect(projection.projectPayload({
      path: realPath,
      payloadBeforePath: realPath,
      payloadAfterPath: realPath,
      beforePath: realPath,
      forkSnapshots: [{ path: realPath, blobSha256: "a".repeat(64) }],
    })).toEqual({
      path: "docs/guides/start.md",
      payloadBeforePath: "docs/guides/start.md",
      payloadAfterPath: "docs/guides/start.md",
      beforePath: "docs/guides/start.md",
      forkSnapshots: [{ path: "docs/guides/start.md", blobSha256: "a".repeat(64) }],
    });
  });

  it("uses the longest selected root and refuses paths outside every root", () => {
    const projection = createAccountlessPathProjection({
      paths: ["clients", "clients/acme/private/docs"],
      versionId: null,
      access: "view",
    });

    expect(projection.projectPath("clients/acme/private/docs/start.md"))
      .toBe("docs/start.md");
    expect(projection.projectPath("clients/other/readme.md"))
      .toBe("clients/other/readme.md");
    expect(projection.projectPath("teams/private/readme.md")).toBeNull();
  });

  it("fails closed when a payload names a path outside every root", () => {
    const projection = createAccountlessPathProjection({
      paths: ["clients/acme/private/docs"],
      versionId: null,
      access: "view",
    });

    expect(
      projection.projectPayload({ path: "teams/private/readme.md" }),
    ).toBeNull();
  });

  it("disambiguates duplicate visible names without colliding with natural names", () => {
    const projection = createAccountlessPathProjection({
      paths: [
        "clients/acme/docs",
        "clients/other/docs",
        "teams/blue/2~docs",
      ],
      versionId: null,
      access: "view",
    });

    expect(projection.selector.paths).toEqual(["docs", "3~docs", "2~docs"]);
    expect(projection.projectPath("clients/acme/docs/one.md")).toBe("docs/one.md");
    expect(projection.projectPath("clients/other/docs/two.md")).toBe("3~docs/two.md");
    expect(projection.projectPath("teams/blue/2~docs/three.md")).toBe("2~docs/three.md");
  });

  it("keeps file extensions when duplicate file roots need aliases", () => {
    const projection = createAccountlessPathProjection({
      paths: ["clients/acme/report.md", "teams/blue/report.md"],
      versionId: null,
      access: "view",
    });

    expect(projection.selector.paths).toEqual(["report.md", "2~report.md"]);
    expect(projection.projectPath("teams/blue/report.md")).toBe("2~report.md");
  });

  it("keeps workspace-relative paths for a whole-version selector", () => {
    const projection = createAccountlessPathProjection({
      paths: [],
      versionId: "snapshot-1",
      access: "view",
    });

    expect(projection.selector.paths).toEqual([]);
    expect(projection.projectPath("clients/acme/report.md"))
      .toBe("clients/acme/report.md");
  });
});
