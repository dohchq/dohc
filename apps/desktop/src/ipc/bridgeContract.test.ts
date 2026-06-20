import { describe, expect, it } from "vitest";
import {
  CreateDataFragmentPayload,
  ListSitesResult,
  StartSitePreviewPayload,
  StartSitePreviewResult,
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
