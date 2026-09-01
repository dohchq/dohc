// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SitePackageInfo } from "../../ipc/bridgeContract";
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
  configuredScripts: {},
  configuredPreviewMode: null,
  configuredBuildOutput: null,
  buildOutputs: ["dist"],
  sourceFiles: ["client-portal/index.html", "client-portal/package.json"],
  shareManifest: { ok: false, reason: "no-runnable-artifact" },
  diagnostics: [],
  authority: { kind: "workspace" },
};

const bridgeMock = {
  listSites: vi.fn(async (_input: { workspaceId: string }) => ({
    sites: [site],
  })),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
        filesSettledRevision={0}
        onOpenPath={onOpenPath}
        onCreateFirstSite={vi.fn()}
      />,
    );

    await screen.findByText("Client Portal");
    await user.click(screen.getByTestId("sites-row"));

    expect(onOpenPath).toHaveBeenCalledWith(siteTabPath("client-portal"));
  });

  it("reloads detected sites when the settled files revision bumps, including a content-only edit", async () => {
    // filesSettledRevision bumps on every settled workspace file listing,
    // including a content-only edit to an EXISTING file (e.g. dohc.json) —
    // not just an add/remove. A structural path/kind/icon hash would
    // produce the SAME value for that case and never rerun this effect.
    const view = render(
      <SitesView
        workspaceId="ws-sites"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstSite={vi.fn()}
      />,
    );
    await screen.findByText("Client Portal");
    expect(bridgeMock.listSites).toHaveBeenCalledTimes(1);

    view.rerender(
      <SitesView
        workspaceId="ws-sites"
        filesSettledRevision={1}
        onOpenPath={vi.fn()}
        onCreateFirstSite={vi.fn()}
      />,
    );

    await vi.waitFor(() => expect(bridgeMock.listSites).toHaveBeenCalledTimes(2));
  });

  it("does not reload detected sites for an unchanged settled files revision", async () => {
    const view = render(
      <SitesView
        workspaceId="ws-sites"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstSite={vi.fn()}
      />,
    );
    await screen.findByText("Client Portal");

    view.rerender(
      <SitesView
        workspaceId="ws-sites"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstSite={vi.fn()}
      />,
    );
    await Promise.resolve();

    expect(bridgeMock.listSites).toHaveBeenCalledTimes(1);
  });

  it("does not let a late workspace response replace the current sites", async () => {
    const workspaceA = deferred<{ sites: SitePackageInfo[] }>();
    const workspaceB = deferred<{ sites: SitePackageInfo[] }>();
    bridgeMock.listSites.mockImplementation((input: { workspaceId: string }) =>
      input.workspaceId === "workspace-a"
        ? workspaceA.promise
        : workspaceB.promise,
    );
    const view = render(
      <SitesView
        workspaceId="workspace-a"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstSite={vi.fn()}
      />,
    );

    view.rerender(
      <SitesView
        workspaceId="workspace-b"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstSite={vi.fn()}
      />,
    );
    await act(async () => {
      workspaceB.resolve({ sites: [{ ...site, title: "Current Site" }] });
      await workspaceB.promise;
    });
    expect(await screen.findByText("Current Site")).toBeTruthy();

    await act(async () => {
      workspaceA.resolve({ sites: [{ ...site, title: "Stale Site" }] });
      await workspaceA.promise;
    });
    expect(screen.getByText("Current Site")).toBeTruthy();
    expect(screen.queryByText("Stale Site")).toBeNull();
  });

  it("does not fabricate sites from files while IPC is loading", () => {
    bridgeMock.listSites.mockImplementationOnce(() => new Promise(() => undefined));
    render(
      <SitesView
        workspaceId="ws-sites"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstSite={vi.fn()}
      />,
    );

    expect(screen.queryByText("Report")).toBeNull();
    expect(screen.queryByTestId("sites-row")).toBeNull();
    expect(screen.getByTestId("sites-count").textContent).toContain("0 sites");
  });

  it("renders the IPC error state", async () => {
    bridgeMock.listSites.mockRejectedValueOnce(new Error("Site scan failed"));
    render(
      <SitesView
        workspaceId="ws-sites"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstSite={vi.fn()}
      />,
    );

    expect(await screen.findByText("Site scan failed")).toBeTruthy();
    expect(screen.getByTestId("sites-count").textContent).toContain("0 sites");
  });

  it("offers a keyboard-accessible first-site action when no sites are detected", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({ sites: [] });
    const onCreateFirstSite = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <SitesView
        workspaceId="ws-sites"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstSite={onCreateFirstSite}
      />,
    );

    expect(await screen.findByText("No sites yet")).toBeTruthy();
    expect(
      screen.getByText("Start with one editable HTML file in your workspace."),
    ).toBeTruthy();
    expect(screen.getByTestId("sites-count").textContent).toContain("0 sites");
    const create = screen.getByRole("button", { name: "Create site" });
    create.focus();
    await user.keyboard("{Enter}");
    expect(onCreateFirstSite).toHaveBeenCalledTimes(1);
  });

  it("does not offer file creation in an empty received share workspace", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({ sites: [] });
    const onCreateFirstSite = vi.fn(async () => undefined);
    render(
      <SitesView
        workspaceId="ws-received-share"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstSite={onCreateFirstSite}
        receivedShareWorkspace
      />,
    );

    expect(
      await screen.findByText(
        "This shared view cannot create a site. Ask the workspace owner to add one.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create site" })).toBeNull();
    expect(screen.queryByTestId("sites-create-first")).toBeNull();
    expect(onCreateFirstSite).not.toHaveBeenCalled();
  });

  it("labels sites opened from a mounted share", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({
      sites: [
        {
          ...site,
          root: "shared-with-me/alex/client-portal",
          authority: { kind: "share", mountRoot: "shared-with-me/alex" },
        },
      ],
    });
    render(
      <SitesView
        workspaceId="ws-sites"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstSite={vi.fn()}
      />,
    );

    await screen.findByText("Client Portal");
    expect(screen.getByTestId("sites-shared-label").textContent).toBe("Shared");
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
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstSite={vi.fn()}
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
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstSite={vi.fn()}
      />,
    );

    await screen.findByText("Client Portal");
    expect(screen.getByTestId("sites-low-confidence").getAttribute("aria-label")).toBe(
      "Low confidence detection",
    );
  });
});
