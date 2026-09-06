// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SitePackageInfo } from "../../ipc/bridgeContract";
import { AppsView } from "./AppsView";
import { siteTabPath } from "./workbenchState";
import { deferred } from "../../testing/deferred";

const app: SitePackageInfo = {
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
    sites: [app],
  })),
};

describe("AppsView", () => {
  beforeEach(() => {
    bridgeMock.listSites.mockReset();
    bridgeMock.listSites.mockResolvedValue({ sites: [app] });
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("lists detected apps and opens app preview tabs", async () => {
    const onOpenPath = vi.fn();
    const user = userEvent.setup();
    render(
      <AppsView
        workspaceId="ws-apps"
        filesSettledRevision={0}
        onOpenPath={onOpenPath}
        onCreateFirstApp={vi.fn()}
      />,
    );

    await screen.findByText("Client Portal");
    await user.click(screen.getByTestId("sites-row"));

    expect(onOpenPath).toHaveBeenCalledWith(siteTabPath("client-portal"));
  });

  it("reloads detected apps when the settled files revision bumps, including a content-only edit", async () => {
    // filesSettledRevision bumps on every settled workspace file listing,
    // including a content-only edit to an existing file (e.g. dohc.json) —
    // not just an add/remove. A structural path/kind/icon hash would
    // produce the same value for that case and never rerun this effect.
    const view = render(
      <AppsView
        workspaceId="ws-apps"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstApp={vi.fn()}
      />,
    );
    await screen.findByText("Client Portal");
    expect(bridgeMock.listSites).toHaveBeenCalledTimes(1);

    view.rerender(
      <AppsView
        workspaceId="ws-apps"
        filesSettledRevision={1}
        onOpenPath={vi.fn()}
        onCreateFirstApp={vi.fn()}
      />,
    );

    await vi.waitFor(() => expect(bridgeMock.listSites).toHaveBeenCalledTimes(2));
  });

  it("does not reload detected apps for an unchanged settled files revision", async () => {
    const view = render(
      <AppsView
        workspaceId="ws-apps"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstApp={vi.fn()}
      />,
    );
    await screen.findByText("Client Portal");

    view.rerender(
      <AppsView
        workspaceId="ws-apps"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstApp={vi.fn()}
      />,
    );
    await Promise.resolve();

    expect(bridgeMock.listSites).toHaveBeenCalledTimes(1);
  });

  it("does not let a late workspace response replace the current apps", async () => {
    const workspaceA = deferred<{ sites: SitePackageInfo[] }>();
    const workspaceB = deferred<{ sites: SitePackageInfo[] }>();
    bridgeMock.listSites.mockImplementation((input: { workspaceId: string }) =>
      input.workspaceId === "workspace-a"
        ? workspaceA.promise
        : workspaceB.promise,
    );
    const view = render(
      <AppsView
        workspaceId="workspace-a"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstApp={vi.fn()}
      />,
    );

    view.rerender(
      <AppsView
        workspaceId="workspace-b"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstApp={vi.fn()}
      />,
    );
    await act(async () => {
      workspaceB.resolve({ sites: [{ ...app, title: "Current App" }] });
      await workspaceB.promise;
    });
    expect(await screen.findByText("Current App")).toBeTruthy();

    await act(async () => {
      workspaceA.resolve({ sites: [{ ...app, title: "Stale App" }] });
      await workspaceA.promise;
    });
    expect(screen.getByText("Current App")).toBeTruthy();
    expect(screen.queryByText("Stale App")).toBeNull();
  });

  it("does not fabricate apps from files while IPC is loading", () => {
    bridgeMock.listSites.mockImplementationOnce(() => new Promise(() => undefined));
    render(
      <AppsView
        workspaceId="ws-apps"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstApp={vi.fn()}
      />,
    );

    expect(screen.queryByText("Report")).toBeNull();
    expect(screen.queryByTestId("sites-row")).toBeNull();
    expect(screen.getByTestId("sites-count").textContent).toContain("0 apps");
  });

  it("renders the IPC error state", async () => {
    bridgeMock.listSites.mockRejectedValueOnce(new Error("App scan failed"));
    render(
      <AppsView
        workspaceId="ws-apps"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstApp={vi.fn()}
      />,
    );

    expect(await screen.findByText("App scan failed")).toBeTruthy();
    expect(screen.getByTestId("sites-count").textContent).toContain("0 apps");
  });

  it("offers a keyboard-accessible first-app action when no apps are detected", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({ sites: [] });
    const onCreateFirstApp = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <AppsView
        workspaceId="ws-apps"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstApp={onCreateFirstApp}
      />,
    );

    expect(await screen.findByText("No apps yet")).toBeTruthy();
    expect(
      screen.getByText("Start with one editable HTML file in your workspace."),
    ).toBeTruthy();
    expect(screen.getByTestId("sites-count").textContent).toContain("0 apps");
    const create = screen.getByRole("button", { name: "Create app" });
    create.focus();
    await user.keyboard("{Enter}");
    expect(onCreateFirstApp).toHaveBeenCalledTimes(1);
  });

  it("does not offer file creation in an empty received share workspace", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({ sites: [] });
    const onCreateFirstApp = vi.fn(async () => undefined);
    render(
      <AppsView
        workspaceId="ws-received-share"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstApp={onCreateFirstApp}
        receivedShareWorkspace
      />,
    );

    expect(
      await screen.findByText(
        "This shared view cannot create an app. Ask the workspace owner to add one.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create app" })).toBeNull();
    expect(screen.queryByTestId("sites-create-first")).toBeNull();
    expect(onCreateFirstApp).not.toHaveBeenCalled();
  });

  it("labels apps opened from a mounted share", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({
      sites: [
        {
          ...app,
          root: "shared-with-me/alex/client-portal",
          authority: { kind: "share", mountRoot: "shared-with-me/alex" },
        },
      ],
    });
    render(
      <AppsView
        workspaceId="ws-apps"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstApp={vi.fn()}
      />,
    );

    await screen.findByText("Client Portal");
    expect(screen.getByTestId("sites-shared-label").textContent).toBe("Shared");
  });

  it("surfaces app diagnostics", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({
      sites: [
        {
          ...app,
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
      <AppsView
        workspaceId="ws-apps"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstApp={vi.fn()}
      />,
    );

    const message = "Warning: dohc.json could not be parsed (client-portal/dohc.json)";
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByTestId("sites-diagnostic-indicator").getAttribute("aria-label")).toBe(
      message,
    );
  });

  it("marks low-confidence app detections", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({
      sites: [{ ...app, confidence: "low" }],
    });
    render(
      <AppsView
        workspaceId="ws-apps"
        filesSettledRevision={0}
        onOpenPath={vi.fn()}
        onCreateFirstApp={vi.fn()}
      />,
    );

    await screen.findByText("Client Portal");
    expect(screen.getByTestId("sites-low-confidence").getAttribute("aria-label")).toBe(
      "Low confidence detection",
    );
  });
});
