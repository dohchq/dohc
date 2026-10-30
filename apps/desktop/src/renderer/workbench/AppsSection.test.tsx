// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SitePackageInfo } from "../../ipc/bridgeContract";
import { hasApps, useApps } from "./AppsSection";
import { Explorer, type ExplorerProps } from "./Explorer";
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
const docs: SitePackageInfo = { ...app, root: "docs", title: "Docs" };

const bridgeMock = {
  listSites: vi.fn(async (_input: { workspaceId: string }) => ({
    sites: [app],
  })),
};

const notices = { report: vi.fn(), clear: vi.fn() };

type HarnessProps = {
  workspaceId?: string;
  filesSettledRevision?: number;
  enabled?: boolean;
  activePath?: string | null;
  pinnedApps?: readonly string[];
  onSetPinned?: (appRoot: string, pinned: boolean) => void;
  onOpenPath?: (path: string) => void;
  reveal?: boolean;
  onRevealed?: () => void;
  onHasApps?: (has: boolean) => void;
};

const noop = () => undefined;

// The shell reads the apps; the Explorer's Home draws the section from them.
function Harness(props: HarnessProps) {
  const apps = useApps(
    props.workspaceId ?? "ws-apps",
    props.filesSettledRevision ?? 0,
    notices,
    props.enabled ?? true,
  );
  props.onHasApps?.(hasApps(apps));
  const activeTab = props.activePath ?? null;
  const explorer: ExplorerProps = {
    workspaceId: props.workspaceId ?? "ws-apps",
    mode: "home",
    onModeChange: noop,
    listed: true,
    recentFiles: [],
    files: [{ path: "client-portal/index.html", kind: "file" }, { path: "docs/index.html", kind: "file" }],
    folders: ["client-portal", "docs"],
    editorGroups: [{ id: "group-1", tabs: activeTab ? [{ path: activeTab }] : [], activeTab, size: 1 }],
    activeEditorGroup: "group-1",
    dirtyPaths: new Set(),
    recoveryPaths: new Set(),
    expandedFolders: [],
    pinned: [],
    openEditorsHeight: 180,
    onOpenEditorsHeightChange: noop,
    newFolderRequest: null,
    onNewPage: noop,
    onOpenFile: props.onOpenPath ?? vi.fn(),
    onActivateTab: noop,
    onCloseTab: noop,
    onCloseAllTabs: noop,
    onNewUntitledTextFile: noop,
    onCollapseFolders: noop,
    onSetFolderExpanded: noop,
    onToggleFolder: noop,
    onTogglePin: noop,
    collectionFolders: new Set(),
    appFolders: new Set(["client-portal", "docs"]),
    onOpenCollection: noop,
    apps: {
      ...apps,
      pinnedApps: props.pinnedApps ?? [],
      onSetPinned: props.onSetPinned ?? vi.fn(),
      reveal: props.reveal ?? false,
      onRevealed: props.onRevealed ?? vi.fn(),
    },
    onPathsChanged: noop,
    onImportFiles: noop,
    shareView: null,
    onRefreshShareMounts: noop,
    onUnmountShare: noop,
    onShare: noop,
    onRefresh: noop,
    onError: noop,
    onNewCollection: noop,
  };
  return <Explorer {...explorer} />;
}

describe("Home's Apps section", () => {
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
    render(<Harness onOpenPath={onOpenPath} />);

    await screen.findByText("Client Portal");
    const row = screen.getByTestId("sites-row");
    // One line: the folder is the row's tooltip, not a second line.
    expect(row.textContent).toBe("Client Portal");
    expect(row.getAttribute("title")).toBe("client-portal");
    await user.click(row);

    expect(onOpenPath).toHaveBeenCalledWith(siteTabPath("client-portal"));
  });

  it("heads the section with its count and no actions", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({ sites: [app, docs] });
    render(<Harness />);

    await screen.findByText("Docs");
    const header = screen.getByTestId("explorer-apps-header");
    const toggle = screen.getByTestId("explorer-apps-toggle");
    expect(header.querySelectorAll("button")).toHaveLength(1);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const count = screen.getByTestId("sites-count");
    expect(count.textContent).toBe("2");
    expect(count.getAttribute("aria-label")).toBe("2 apps");
    expect(screen.queryByRole("button", { name: /create app/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /refresh/i })).toBeNull();
  });

  it("selects the app whose preview is the focused tab", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({ sites: [app, docs] });
    render(<Harness activePath={siteTabPath("docs")} />);

    await screen.findByText("Docs");
    const [portal, docsRow] = screen.getAllByTestId("sites-row");
    expect(portal?.getAttribute("aria-current")).toBeNull();
    expect(docsRow?.getAttribute("aria-current")).toBe("page");
    expect(docsRow?.parentElement?.className).toContain("bg-selected");
    expect(docsRow?.parentElement?.className).toContain("font-medium");
    expect(portal?.parentElement?.className).toContain("hover:bg-hover");
  });

  it("pins an app to the sidebar and unpins a pinned one, without opening it", async () => {
    const onOpenPath = vi.fn();
    const onSetPinned = vi.fn();
    const user = userEvent.setup();
    const view = render(<Harness onOpenPath={onOpenPath} onSetPinned={onSetPinned} />);
    await user.click(await screen.findByRole("button", { name: "Pin to sidebar" }));
    expect(onSetPinned).toHaveBeenLastCalledWith("client-portal", true);

    view.rerender(<Harness onOpenPath={onOpenPath} onSetPinned={onSetPinned} pinnedApps={["client-portal"]} />);
    await user.click(screen.getByRole("button", { name: "Unpin" }));
    expect(onSetPinned).toHaveBeenLastCalledWith("client-portal", false);
    expect(onOpenPath).not.toHaveBeenCalled();
  });

  it("reaches the header and each row from the keyboard", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({ sites: [app, docs] });
    const onOpenPath = vi.fn();
    const user = userEvent.setup();
    render(<Harness onOpenPath={onOpenPath} />);
    await screen.findByText("Docs");
    const toggle = screen.getByTestId("explorer-apps-toggle");
    const [portalRow, docsRow] = screen.getAllByTestId("sites-row");
    // A pin is a pointer shortcut; the keyboard pins through the row's menu.
    for (const pin of screen.getAllByTestId("sites-pin")) expect(pin.tabIndex).toBe(-1);

    toggle.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(portalRow);
    await user.keyboard("{Enter}");
    expect(onOpenPath).toHaveBeenLastCalledWith(siteTabPath("client-portal"));

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(docsRow);
    await user.keyboard("{Enter}");
    expect(onOpenPath).toHaveBeenLastCalledWith(siteTabPath("docs"));

    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(toggle);
    await user.keyboard("{ArrowLeft}");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("sites-row")).toBeNull();
  });

  it("collapses to its header and keeps the count", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByText("Client Portal");

    await user.click(screen.getByTestId("explorer-apps-toggle"));
    expect(screen.queryByTestId("sites-row")).toBeNull();
    expect(screen.getByTestId("sites-count").getAttribute("aria-label")).toBe("1 app");

    await user.click(screen.getByTestId("explorer-apps-toggle"));
    expect(screen.getByTestId("sites-row")).toBeTruthy();
  });

  it("reloads detected apps when the settled files revision bumps, including a content-only edit", async () => {
    // filesSettledRevision bumps on every settled workspace file listing,
    // including a content-only edit to an existing file (e.g. dohc.json) —
    // not just an add/remove. A structural path/kind/icon hash would
    // produce the same value for that case and never rerun this effect.
    const view = render(<Harness />);
    await screen.findByText("Client Portal");
    expect(bridgeMock.listSites).toHaveBeenCalledTimes(1);

    view.rerender(<Harness filesSettledRevision={1} />);

    await vi.waitFor(() => expect(bridgeMock.listSites).toHaveBeenCalledTimes(2));
  });

  it("keeps the apps and their count on screen while a settled listing refetches", async () => {
    const view = render(<Harness />);
    await screen.findByText("Client Portal");
    const refetch = deferred<{ sites: SitePackageInfo[] }>();
    bridgeMock.listSites.mockReturnValueOnce(refetch.promise);

    view.rerender(<Harness filesSettledRevision={1} />);
    await vi.waitFor(() => expect(bridgeMock.listSites).toHaveBeenCalledTimes(2));

    expect(screen.getByText("Client Portal")).toBeTruthy();
    expect(screen.getByTestId("sites-count").textContent).toBe("1");

    await act(async () => {
      refetch.resolve({ sites: [app, docs] });
      await refetch.promise;
    });
    expect(screen.getByTestId("sites-count").textContent).toBe("2");
  });

  it("does not reload detected apps for an unchanged settled files revision", async () => {
    const view = render(<Harness />);
    await screen.findByText("Client Portal");

    view.rerender(<Harness />);
    await Promise.resolve();

    expect(bridgeMock.listSites).toHaveBeenCalledTimes(1);
  });

  it("reads nothing until the workspace is ready", async () => {
    const view = render(<Harness enabled={false} />);
    await Promise.resolve();
    expect(bridgeMock.listSites).not.toHaveBeenCalled();
    expect(screen.queryByTestId("explorer-apps-section")).toBeNull();

    view.rerender(<Harness enabled />);
    expect(await screen.findByText("Client Portal")).toBeTruthy();
  });

  it("does not let a late workspace response replace the current apps or report a failure", async () => {
    const workspaceA = deferred<{ sites: SitePackageInfo[] }>();
    const workspaceB = deferred<{ sites: SitePackageInfo[] }>();
    bridgeMock.listSites.mockImplementation((input: { workspaceId: string }) =>
      input.workspaceId === "workspace-a"
        ? workspaceA.promise
        : workspaceB.promise,
    );
    const view = render(<Harness workspaceId="workspace-a" />);

    view.rerender(<Harness workspaceId="workspace-b" />);
    await act(async () => {
      workspaceB.resolve({ sites: [{ ...app, title: "Current App" }] });
      await workspaceB.promise;
    });
    expect(await screen.findByText("Current App")).toBeTruthy();

    await act(async () => {
      workspaceA.reject(new Error("Workspace A scan failed"));
      await workspaceA.promise.catch(() => undefined);
    });
    expect(screen.getByText("Current App")).toBeTruthy();
    expect(notices.report).not.toHaveBeenCalled();
    // Leaving workspace A took its row, if it had one.
    expect(notices.clear).toHaveBeenCalledWith("apps:workspace-a");
  });

  it("draws no section while the first read is on its way", () => {
    bridgeMock.listSites.mockImplementationOnce(() => new Promise(() => undefined));
    render(<Harness />);

    expect(screen.queryByTestId("explorer-apps-section")).toBeNull();
    expect(screen.queryByTestId("sites-row")).toBeNull();
  });

  it("draws no section for a workspace with no apps, then shows one once an app settles", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({ sites: [] });
    const onHasApps = vi.fn();
    const view = render(<Harness onHasApps={onHasApps} />);
    await vi.waitFor(() => expect(bridgeMock.listSites).toHaveBeenCalledTimes(1));
    await act(async () => undefined);

    expect(screen.queryByTestId("explorer-apps-section")).toBeNull();
    expect(onHasApps).toHaveBeenLastCalledWith(false);

    // An agent wrote an app folder; the listing settled.
    view.rerender(<Harness filesSettledRevision={1} onHasApps={onHasApps} />);
    expect(await screen.findByText("Client Portal")).toBeTruthy();
    expect(screen.getByTestId("explorer-apps-section")).toBeTruthy();
    expect(onHasApps).toHaveBeenLastCalledWith(true);
  });

  it("reports a failed read through the shell's error hook and reads again on Try again", async () => {
    const failure = new Error("App scan failed");
    bridgeMock.listSites.mockRejectedValueOnce(failure);
    const user = userEvent.setup();
    render(<Harness />);

    const row = await screen.findByTestId("sites-failed");
    // The section keeps its header; the words are the Notices row's.
    expect(screen.getByTestId("explorer-apps-toggle")).toBeTruthy();
    expect(row.textContent).toBe("Try again");
    expect(screen.queryByText("App scan failed")).toBeNull();
    expect(screen.queryByTestId("sites-count")).toBeNull();
    expect(notices.report).toHaveBeenCalledExactlyOnceWith({
      identity: "apps:ws-apps",
      message: "App scan failed",
      cause: failure,
      retry: expect.any(Function),
    });

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Client Portal")).toBeTruthy();
    expect(bridgeMock.listSites).toHaveBeenCalledTimes(2);
    expect(notices.clear).toHaveBeenLastCalledWith("apps:ws-apps");
  });

  it("reads again from the Notices row's Try again", async () => {
    bridgeMock.listSites.mockRejectedValueOnce(new Error("App scan failed"));
    render(<Harness />);
    await screen.findByTestId("sites-failed");

    const [{ retry }] = notices.report.mock.calls[0] as [{ retry: () => void }];
    act(() => retry());

    expect(await screen.findByText("Client Portal")).toBeTruthy();
  });

  it("takes its Notices row away when the workspace closes", async () => {
    bridgeMock.listSites.mockRejectedValueOnce(new Error("App scan failed"));
    const view = render(<Harness />);
    await screen.findByTestId("sites-failed");
    notices.clear.mockClear();

    view.unmount();

    expect(notices.clear).toHaveBeenCalledExactlyOnceWith("apps:ws-apps");
  });

  it("opens and focuses its first row for Add an app here…", async () => {
    bridgeMock.listSites.mockResolvedValue({ sites: [app, docs] });
    const onRevealed = vi.fn();
    const user = userEvent.setup();
    const view = render(<Harness onRevealed={onRevealed} />);
    await screen.findByText("Docs");
    await user.click(screen.getByTestId("explorer-apps-toggle"));
    expect(screen.queryByTestId("sites-row")).toBeNull();

    view.rerender(<Harness reveal onRevealed={onRevealed} />);

    const [first] = await screen.findAllByTestId("sites-row");
    await vi.waitFor(() => expect(document.activeElement).toBe(first));
    expect(screen.getByTestId("explorer-apps-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(onRevealed).toHaveBeenCalledOnce();
  });

  it("drops an Add an app here… request once the read finds no apps", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({ sites: [] });
    const onRevealed = vi.fn();
    render(<Harness reveal onRevealed={onRevealed} />);

    await vi.waitFor(() => expect(onRevealed).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("explorer-apps-section")).toBeNull();
  });

  it("marks apps opened from a mounted share", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({
      sites: [
        {
          ...app,
          root: "shared-with-me/alex/client-portal",
          authority: { kind: "share", mountRoot: "shared-with-me/alex" },
        },
      ],
    });
    render(<Harness />);

    await screen.findByText("Client Portal");
    expect(screen.getByRole("img", { name: "Shared" }).getAttribute("data-testid")).toBe(
      "sites-shared-label",
    );
  });

  it("marks app diagnostics, with their words as the mark's name", async () => {
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
    render(<Harness />);

    const message = "Warning: dohc.json could not be parsed (client-portal/dohc.json)";
    const mark = await screen.findByRole("img", { name: message });
    expect(mark.getAttribute("data-testid")).toBe("sites-diagnostic-indicator");
    expect(mark.getAttribute("title")).toBe(message);
  });

  it("marks low-confidence app detections", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({
      sites: [{ ...app, confidence: "low" }],
    });
    render(<Harness />);

    await screen.findByText("Client Portal");
    expect(screen.getByTestId("sites-low-confidence").getAttribute("aria-label")).toBe(
      "Low confidence detection",
    );
  });

  it("keeps a pinned app's pin in view and hides the others until hover or focus", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({ sites: [app, docs] });
    render(<Harness pinnedApps={["client-portal"]} />);

    const pinned = await screen.findByRole("button", { name: "Unpin" });
    const unpinned = screen.getByRole("button", { name: "Pin to sidebar" });
    expect(pinned.className).not.toContain("opacity-0");
    expect(pinned.querySelector("svg")?.getAttribute("class")).toContain("text-ink");
    expect(unpinned.className).toContain("opacity-0");
    expect(unpinned.className).toContain("group-has-[:focus-visible]:opacity-100");
  });
});
