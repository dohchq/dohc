// @vitest-environment jsdom
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { StartSitePreviewPayload } from "../../ipc/bridgeContract";
import { DEFAULT_WORKSPACE_SETTINGS } from "../../workspaces/workspaceSettings";
import { listSitePackages } from "../../workspaces/sitePackage";
import { startStaticSitePreview, type StaticSitePreview } from "../../workspaces/siteRunner";
import { listFiles } from "../../workspaces/workspaceFiles";
import { SitePreviewPage } from "../SitePreviewPage";
import { selectListedSitePackage } from "../../testing/sitePackageTestOracle";
import { createFirstAppFiles } from "./createFirstApp";

const spawn = vi.hoisted(() => vi.fn(() => { throw new Error("unexpected child process"); }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn,
}));

it("opens the desktop's first app in static mode without spawning a process", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-first-app-preview-"));
  let preview: StaticSitePreview | undefined;
  try {
    const { root } = await createFirstAppFiles({
      workspaceId: "ws-new-app", files: [], folders: [],
      mutations: {
        createWorkspaceFolder: async ({ relativePath }) => {
          await mkdir(join(workspaceRoot, relativePath));
          return { path: relativePath };
        },
        createWorkspaceFile: async ({ relativePath, initialText }) => {
          await writeFile(join(workspaceRoot, relativePath), initialText ?? "", { flag: "wx" });
          return { path: relativePath };
        },
        deleteWorkspacePath: async ({ relativePath }) => {
          await rm(join(workspaceRoot, relativePath), { recursive: true });
          return { trashed: false };
        },
      },
    });
    const packages = await listSitePackages(workspaceRoot, await listFiles(workspaceRoot));
    const site = selectListedSitePackage(root, packages);
    expect(site?.scripts.dev).toBeTruthy();
    const startSitePreview = vi.fn(async (payload: StartSitePreviewPayload) => {
      if (payload.mode !== "static") spawn();
      preview = await startStaticSitePreview(workspaceRoot, payload.siteRoot, { authority: { kind: "workspace" } });
      return { siteRoot: root, mode: "static" as const, url: preview.url, logs: [], exited: false, generation: 1 };
    });
    window.localStorage.clear();
    vi.stubGlobal("dohcDesktop", {
      getSitePackage: async () => site,
      getWorkspaceSettings: async () => ({ settings: DEFAULT_WORKSPACE_SETTINGS, source: "default" }),
      startSitePreview,
      stopSitePreview: async () => { await preview?.stop(); },
      getSitePreviewLogs: async () => ({ logs: [], exited: false }),
      onSitePreviewReplaced: () => () => undefined,
      // New workspace made this workspace, so main trusts it.
      readWorkspaceTrust: async ({ workspaceId }: { workspaceId: string }) => ({ workspaceId, trusted: true }),
      onWorkspaceTrustChanged: () => () => undefined,
    });
    render(<SitePreviewPage workspaceId="ws-new-app" siteRoot={root} />);
    await waitFor(() => expect(startSitePreview).toHaveBeenCalledOnce());
    expect(startSitePreview).toHaveBeenCalledWith(expect.objectContaining({ mode: "static", restart: false }));
    const frame = await screen.findByTestId("site-preview-frame");
    expect(frame.getAttribute("src")).toBe(preview!.url);
    expect(site?.configuredPreviewMode).toBe("static");
    expect(await (await fetch(preview!.url)).text()).toContain("<h1>My app</h1>");
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    await preview?.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
