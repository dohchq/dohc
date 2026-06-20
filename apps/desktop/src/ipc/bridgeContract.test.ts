import { describe, expect, it } from "vitest";
import {
  CreateDataFragmentPayload,
  ListSitesResult,
  StartSitePreviewPayload,
  StartSitePreviewResult,
  StopSitePreviewPayload,
} from "./bridgeContract";

describe("site IPC contract", () => {
  it("accepts detected normal website metadata", () => {
    expect(
      ListSitesResult.parse({
        sites: [
          {
            root: "client-portal",
            title: "Client Portal",
            kind: "package",
            confidence: "high",
            entryPath: "client-portal/index.html",
            configPath: "client-portal/vite.config.ts",
            packagePath: "client-portal/package.json",
            packageManager: "pnpm",
            scripts: { dev: "vite", build: "vite build" },
            buildOutputs: ["dist"],
            sourceFiles: ["client-portal/index.html", "client-portal/package.json"],
            diagnostics: [],
          },
        ],
      }).sites[0]?.root,
    ).toBe("client-portal");
    expect(ListSitesResult.parse({ sites: [] }).sites).toEqual([]);
    expect(
      ListSitesResult.parse({
        sites: [
          {
            root: "static",
            title: "Static",
            kind: "static",
            confidence: "medium",
            entryPath: null,
            configPath: null,
            packagePath: null,
            packageManager: null,
            scripts: {},
            buildOutputs: [],
            sourceFiles: [],
            diagnostics: [],
          },
        ],
      }).sites[0]?.entryPath,
    ).toBeNull();
  });

  it("accepts bounded preview start/result payloads", () => {
    expect(
      StartSitePreviewPayload.parse({
        workspaceId: "ws-sites",
        siteRoot: ".",
        mode: "static",
      }),
    ).toEqual({
      workspaceId: "ws-sites",
      siteRoot: ".",
      mode: "static",
    });

    expect(
      StartSitePreviewResult.parse({
        siteRoot: ".",
        mode: "build",
        url: "http://127.0.0.1:4173/",
        logs: [{ stream: "stdout", text: "built", at: 1 }],
        build: {
          ok: true,
          command: "pnpm",
          args: ["build"],
          outputPath: "/tmp/workspace/dist",
          exitCode: 0,
        },
      }).mode,
    ).toBe("build");
    expect(
      StartSitePreviewResult.parse({
        siteRoot: "site",
        mode: "static",
        url: "http://localhost:4173/",
        logs: [],
      }).logs,
    ).toEqual([]);
    expect(
      StopSitePreviewPayload.parse({
        workspaceId: "ws-sites",
        siteRoot: "site",
      }),
    ).toEqual({ workspaceId: "ws-sites", siteRoot: "site" });
  });

  it("rejects unknown preview modes and non-local preview URLs", () => {
    expect(
      StartSitePreviewPayload.safeParse({
        workspaceId: "ws-sites",
        siteRoot: "site",
        mode: "native",
      }).success,
    ).toBe(false);
    expect(
      StartSitePreviewResult.safeParse({
        siteRoot: "site",
        mode: "static",
        url: "http://127.0.0.1:43210",
        logs: [],
      }).success,
    ).toBe(true);
    expect(
      StartSitePreviewResult.safeParse({
        siteRoot: "site",
        mode: "static",
        url: "http://[::1]:43210/",
        logs: [],
      }).success,
    ).toBe(true);
    for (const url of [
      "https://example.com/",
      "file:///tmp/site/index.html",
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "http://0.0.0.0:43210/",
      "http://user:pass@127.0.0.1:43210/",
      "http://127.0.0.1/",
      "http://127.0.0.1:abc/",
      "http://127.0.0.1:0/",
      "http://127.0.0.1:70000/",
    ]) {
      expect(
        StartSitePreviewResult.safeParse({
          siteRoot: "site",
          mode: "static",
          url,
          logs: [],
        }).success,
      ).toBe(false);
    }
    expect(
      StartSitePreviewResult.safeParse({
        siteRoot: "site",
        mode: "static",
        url: "https://example.com/",
        logs: [],
      }).success,
    ).toBe(false);
  });
});

describe("data fragment IPC contract", () => {
  it("accepts a bounded Cloud data fragment export request", () => {
    expect(
      CreateDataFragmentPayload.parse({
        workspaceId: "ws-fragments",
        sourcePath: "notes/day.md",
        body: "10 apples",
        recipientEmail: "peer@dohc.test",
      }),
    ).toEqual({
      workspaceId: "ws-fragments",
      sourcePath: "notes/day.md",
      body: "10 apples",
      recipientEmail: "peer@dohc.test",
    });
  });

  it("rejects empty, oversized, or malformed data fragment export requests", () => {
    expect(
      CreateDataFragmentPayload.safeParse({
        workspaceId: "ws-fragments",
        body: "",
        recipientEmail: "peer@dohc.test",
      }).success,
    ).toBe(false);
    expect(
      CreateDataFragmentPayload.safeParse({
        workspaceId: "ws-fragments",
        body: "x".repeat(200_001),
        recipientEmail: "peer@dohc.test",
      }).success,
    ).toBe(false);
    expect(
      CreateDataFragmentPayload.safeParse({
        workspaceId: "ws-fragments",
        body: "10 apples",
        recipientEmail: "not-an-email",
      }).success,
    ).toBe(false);
  });
});
