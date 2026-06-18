import { describe, expect, it } from "vitest";
import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { discoverWorkspaceApps } from "./AppsView";

function file(path: string): WorkspaceFileEntry {
  return {
    path,
    kind: path.includes("/.apps/") || path.startsWith(".apps/")
      ? "app-source"
      : "file",
  };
}

describe("discoverWorkspaceApps", () => {
  it("lists root and scoped app packages in stable path order", () => {
    const apps = discoverWorkspaceApps([
      file("notes/today.md"),
      file("finance/.apps/ledger/src/App.tsx"),
      file("finance/.apps/ledger/app.json"),
      file(".apps/dashboard/app.json"),
      file(".apps/dashboard/src/App.tsx"),
    ]);

    expect(apps.map((app) => app.root)).toEqual([
      ".apps/dashboard",
      "finance/.apps/ledger",
    ]);
    expect(apps[0]).toMatchObject({
      name: "dashboard",
      manifestPath: ".apps/dashboard/app.json",
      openPath: ".apps/dashboard/app.json",
      status: "package",
    });
    expect(apps[1]?.sourceFiles).toEqual([
      "finance/.apps/ledger/app.json",
      "finance/.apps/ledger/src/App.tsx",
    ]);
  });

  it("surfaces incomplete app folders instead of hiding them", () => {
    const apps = discoverWorkspaceApps([
      file("finance/.apps/draft/src/App.tsx"),
      file("finance/.apps/draft/README.md"),
    ]);

    expect(apps).toEqual([
      {
        name: "draft",
        root: "finance/.apps/draft",
        manifestPath: null,
        openPath: "finance/.apps/draft/README.md",
        sourceFiles: [
          "finance/.apps/draft/README.md",
          "finance/.apps/draft/src/App.tsx",
        ],
        status: "incomplete",
      },
    ]);
  });

  it("returns an empty list for regular workspace files", () => {
    expect(discoverWorkspaceApps([file("docs/plan.md"), file("data/table.csv")])).toEqual([]);
  });
});
