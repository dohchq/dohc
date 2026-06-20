// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SitePackageInfo, WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { SitesView } from "./SitesView";
import { siteTabPath } from "./workbenchState";

const site: SitePackageInfo = {
  root: "client-portal",
  title: "Client Portal",
  kind: "package",
  confidence: "high",
  entryPath: "client-portal/index.html",
  configPath: null,
  packagePath: "client-portal/package.json",
  packageManager: "pnpm",
  scripts: { dev: "vite", build: "vite build" },
  buildOutputs: ["dist"],
  sourceFiles: ["client-portal/index.html", "client-portal/package.json"],
  diagnostics: [],
};

const bridgeMock = {
  listSites: vi.fn(async () => ({ sites: [site] })),
};

function file(path: string): WorkspaceFileEntry {
  return { path, kind: "file" };
}

describe("SitesView", () => {
  beforeEach(() => {
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("lists detected sites and opens site preview tabs", async () => {
    const onOpenPath = vi.fn();
    const user = userEvent.setup();
    render(
      <SitesView
        workspaceId="ws-sites"
        files={[]}
        onOpenPath={onOpenPath}
      />,
    );

    await screen.findByText("Client Portal");
    await user.click(screen.getByTestId("sites-row"));

    expect(onOpenPath).toHaveBeenCalledWith(siteTabPath("client-portal"));
  });

  it("falls back to static file detection while IPC is loading", async () => {
    bridgeMock.listSites.mockImplementationOnce(() => new Promise(() => undefined));
    render(
      <SitesView
        workspaceId="ws-sites"
        files={[file("report/index.html")]}
        onOpenPath={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("Report")).toBeTruthy());
    expect(screen.getByTestId("sites-count").textContent).toContain("1 site");
  });
});
