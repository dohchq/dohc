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
    bridgeMock.listSites.mockReset();
    bridgeMock.listSites.mockResolvedValue({ sites: [site] });
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

  it("uses a default title for root-level static detection", async () => {
    bridgeMock.listSites.mockImplementationOnce(() => new Promise(() => undefined));
    render(
      <SitesView
        workspaceId="ws-sites"
        files={[file("index.html")]}
        onOpenPath={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("Workspace Site")).toBeTruthy());
  });

  it("renders the IPC error state", async () => {
    bridgeMock.listSites.mockRejectedValueOnce(new Error("Site scan failed"));
    render(
      <SitesView
        workspaceId="ws-sites"
        files={[]}
        onOpenPath={vi.fn()}
      />,
    );

    expect(await screen.findByText("Site scan failed")).toBeTruthy();
    expect(screen.getByTestId("sites-count").textContent).toContain("0 sites");
  });

  it("renders an empty state when no sites are detected", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({ sites: [] });
    render(
      <SitesView
        workspaceId="ws-sites"
        files={[]}
        onOpenPath={vi.fn()}
      />,
    );

    expect(await screen.findByText("No sites")).toBeTruthy();
    expect(screen.getByTestId("sites-count").textContent).toContain("0 sites");
  });

  it("surfaces site diagnostics", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({
      sites: [
        {
          ...site,
          diagnostics: [
            {
              path: "client-portal/dohc.json",
              severity: "warning",
              code: "invalid-config",
              message: "dohc.json could not be parsed",
            },
          ],
        },
      ],
    });
    render(
      <SitesView
        workspaceId="ws-sites"
        files={[]}
        onOpenPath={vi.fn()}
      />,
    );

    const message = "Warning: dohc.json could not be parsed (client-portal/dohc.json)";
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByTestId("sites-diagnostic-indicator").getAttribute("aria-label")).toBe(
      message,
    );
  });

  it("marks low-confidence site detections", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({
      sites: [{ ...site, confidence: "low" }],
    });
    render(
      <SitesView
        workspaceId="ws-sites"
        files={[]}
        onOpenPath={vi.fn()}
      />,
    );

    await screen.findByText("Client Portal");
    expect(screen.getByTestId("sites-low-confidence").getAttribute("aria-label")).toBe(
      "Low confidence detection",
    );
  });
});
