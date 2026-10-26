// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
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

const notices = { report: vi.fn(), clear: vi.fn() };

type Props = ComponentProps<typeof AppsView>;

// The side panel's header the count and create button portal into.
let head: HTMLElement;

function props(overrides: Partial<Props> = {}): Props {
  return {
    workspaceId: "ws-apps",
    filesSettledRevision: 0,
    head,
    activePath: null,
    pinnedApps: [],
    onSetPinned: vi.fn(),
    onOpenPath: vi.fn(),
    onCreateFirstApp: vi.fn(async () => undefined),
    notices,
    ...overrides,
  };
}

describe("AppsView", () => {
  beforeEach(() => {
    bridgeMock.listSites.mockReset();
    bridgeMock.listSites.mockResolvedValue({ sites: [app] });
    vi.stubGlobal("dohcDesktop", bridgeMock);
    head = document.createElement("span");
    document.body.append(head);
  });

  afterEach(() => {
    cleanup();
    head.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("lists detected apps and opens app preview tabs", async () => {
    const onOpenPath = vi.fn();
    const user = userEvent.setup();
    render(<AppsView {...props({ onOpenPath })} />);

    await screen.findByText("Client Portal");
    await user.click(screen.getByTestId("sites-row"));

    expect(onOpenPath).toHaveBeenCalledWith(siteTabPath("client-portal"));
  });

  it("puts the count and the create button in the panel header", async () => {
    render(<AppsView {...props()} />);

    await screen.findByText("Client Portal");
    expect(head.contains(screen.getByTestId("sites-count"))).toBe(true);
    expect(head.contains(screen.getByTestId("sites-create"))).toBe(true);
  });

  it("selects the app whose preview is the focused tab", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({
      sites: [app, { ...app, root: "docs", title: "Docs" }],
    });
    render(<AppsView {...props({ activePath: siteTabPath("docs") })} />);

    await screen.findByText("Docs");
    const [portal, docs] = screen.getAllByTestId("sites-row");
    expect(portal?.getAttribute("aria-current")).toBeNull();
    expect(docs?.getAttribute("aria-current")).toBe("page");
  });

  it("pins an app to the sidebar and unpins a pinned one, without opening it", async () => {
    const onOpenPath = vi.fn();
    const onSetPinned = vi.fn();
    const user = userEvent.setup();
    const view = render(<AppsView {...props({ onOpenPath, onSetPinned })} />);
    await user.click(await screen.findByRole("button", { name: "Pin to sidebar" }));
    expect(onSetPinned).toHaveBeenLastCalledWith("client-portal", true);

    view.rerender(<AppsView {...props({ onOpenPath, onSetPinned, pinnedApps: ["client-portal"] })} />);
    await user.click(screen.getByRole("button", { name: "Unpin" }));
    expect(onSetPinned).toHaveBeenLastCalledWith("client-portal", false);
    expect(onOpenPath).not.toHaveBeenCalled();
  });

  it("reaches each row and its pin from the keyboard", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({
      sites: [app, { ...app, root: "docs", title: "Docs" }],
    });
    const onOpenPath = vi.fn();
    const onSetPinned = vi.fn();
    const user = userEvent.setup();
    render(<AppsView {...props({ onOpenPath, onSetPinned })} />);
    await screen.findByText("Docs");
    const [portalRow, docsRow] = screen.getAllByTestId("sites-row");
    const [portalPin] = screen.getAllByTestId("sites-pin");

    portalRow?.focus();
    await user.keyboard("{Enter}");
    expect(onOpenPath).toHaveBeenLastCalledWith(siteTabPath("client-portal"));

    await user.tab();
    expect(document.activeElement).toBe(portalPin);
    await user.keyboard(" ");
    expect(onSetPinned).toHaveBeenLastCalledWith("client-portal", true);

    await user.tab();
    expect(document.activeElement).toBe(docsRow);
    await user.keyboard("{Enter}");
    expect(onOpenPath).toHaveBeenLastCalledWith(siteTabPath("docs"));
  });

  it("reloads detected apps when the settled files revision bumps, including a content-only edit", async () => {
    // filesSettledRevision bumps on every settled workspace file listing,
    // including a content-only edit to an existing file (e.g. dohc.json) —
    // not just an add/remove. A structural path/kind/icon hash would
    // produce the same value for that case and never rerun this effect.
    const view = render(<AppsView {...props()} />);
    await screen.findByText("Client Portal");
    expect(bridgeMock.listSites).toHaveBeenCalledTimes(1);

    view.rerender(<AppsView {...props({ filesSettledRevision: 1 })} />);

    await vi.waitFor(() => expect(bridgeMock.listSites).toHaveBeenCalledTimes(2));
  });

  it("keeps the apps and their count on screen while a settled listing refetches", async () => {
    const view = render(<AppsView {...props()} />);
    await screen.findByText("Client Portal");
    const refetch = deferred<{ sites: SitePackageInfo[] }>();
    bridgeMock.listSites.mockReturnValueOnce(refetch.promise);

    view.rerender(<AppsView {...props({ filesSettledRevision: 1 })} />);
    await vi.waitFor(() => expect(bridgeMock.listSites).toHaveBeenCalledTimes(2));

    expect(screen.getByText("Client Portal")).toBeTruthy();
    expect(screen.getByTestId("sites-count").textContent).toBe("1 app");
    expect(screen.queryByText("Loading apps…")).toBeNull();

    await act(async () => {
      refetch.resolve({ sites: [app, { ...app, root: "docs", title: "Docs" }] });
      await refetch.promise;
    });
    expect(screen.getByTestId("sites-count").textContent).toBe("2 apps");
  });

  it("does not reload detected apps for an unchanged settled files revision", async () => {
    const view = render(<AppsView {...props()} />);
    await screen.findByText("Client Portal");

    view.rerender(<AppsView {...props()} />);
    await Promise.resolve();

    expect(bridgeMock.listSites).toHaveBeenCalledTimes(1);
  });

  it("does not let a late workspace response replace the current apps or report a failure", async () => {
    const workspaceA = deferred<{ sites: SitePackageInfo[] }>();
    const workspaceB = deferred<{ sites: SitePackageInfo[] }>();
    bridgeMock.listSites.mockImplementation((input: { workspaceId: string }) =>
      input.workspaceId === "workspace-a"
        ? workspaceA.promise
        : workspaceB.promise,
    );
    const view = render(<AppsView {...props({ workspaceId: "workspace-a" })} />);

    view.rerender(<AppsView {...props({ workspaceId: "workspace-b" })} />);
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

  it("does not fabricate apps from files while IPC is loading", () => {
    bridgeMock.listSites.mockImplementationOnce(() => new Promise(() => undefined));
    render(<AppsView {...props()} />);

    expect(screen.queryByText("Report")).toBeNull();
    expect(screen.queryByTestId("sites-row")).toBeNull();
    expect(screen.getByText("Loading apps…")).toBeTruthy();
    // No count until one is known: "0 apps" would be a claim.
    expect(screen.getByTestId("sites-count").textContent).toBe("");
  });

  it("reports a failed read through the shell's error hook and reads again on Try again", async () => {
    const failure = new Error("App scan failed");
    bridgeMock.listSites.mockRejectedValueOnce(failure);
    const user = userEvent.setup();
    render(<AppsView {...props()} />);

    const panel = await screen.findByTestId("sites-failed");
    // The words are the Notices row's, not the panel's.
    expect(panel.textContent).toBe("Try again");
    expect(screen.queryByText("App scan failed")).toBeNull();
    expect(screen.getByTestId("sites-count").textContent).toBe("");
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
    render(<AppsView {...props()} />);
    await screen.findByTestId("sites-failed");

    const [{ retry }] = notices.report.mock.calls[0] as [{ retry: () => void }];
    act(() => retry());

    expect(await screen.findByText("Client Portal")).toBeTruthy();
  });

  it("takes its Notices row away when the view closes", async () => {
    bridgeMock.listSites.mockRejectedValueOnce(new Error("App scan failed"));
    const view = render(<AppsView {...props()} />);
    await screen.findByTestId("sites-failed");
    notices.clear.mockClear();

    view.unmount();

    expect(notices.clear).toHaveBeenCalledExactlyOnceWith("apps:ws-apps");
  });

  it("offers a keyboard-accessible first-app action when no apps are detected", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({ sites: [] });
    const onCreateFirstApp = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<AppsView {...props({ onCreateFirstApp })} />);

    expect(await screen.findByText("No apps in this workspace yet.")).toBeTruthy();
    expect(screen.getByTestId("sites-count").textContent).toContain("0 apps");
    // An empty shelf offers one create button, in its body.
    expect(screen.queryByTestId("sites-create")).toBeNull();
    const create = screen.getByRole("button", { name: "Create app" });
    create.focus();
    await user.keyboard("{Enter}");
    expect(onCreateFirstApp).toHaveBeenCalledTimes(1);
  });

  it("creates another app from the header and hands one to the agent", async () => {
    const onCreateFirstApp = vi.fn(async () => undefined);
    const ask = vi.fn();
    const user = userEvent.setup();
    render(
      <AppsView
        {...props({ onCreateFirstApp, askAgent: { ready: true, ask, setUp: vi.fn() } })}
      />,
    );

    await screen.findByText("Client Portal");
    await user.click(screen.getByRole("button", { name: "Create app" }));
    expect(onCreateFirstApp).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Ask my agent for an app" }));
    expect(ask).toHaveBeenCalledExactlyOnceWith({ kind: "app" });
  });

  it("does not offer file creation in an empty received share workspace", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({ sites: [] });
    const onCreateFirstApp = vi.fn(async () => undefined);
    render(
      <AppsView
        {...props({
          workspaceId: "ws-received-share",
          onCreateFirstApp,
          receivedShareWorkspace: true,
          askAgent: { ready: true, ask: vi.fn(), setUp: vi.fn() },
        })}
      />,
    );

    // One line under the picture, with no action.
    const line = await screen.findByText("No apps in this workspace yet.");
    expect(line.parentElement!.textContent).toBe("No apps in this workspace yet.");
    expect(screen.queryByRole("button", { name: "Create app" })).toBeNull();
    expect(screen.queryByTestId("sites-create-first")).toBeNull();
    expect(screen.queryByTestId("ask-agent")).toBeNull();
    expect(onCreateFirstApp).not.toHaveBeenCalled();
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
    render(<AppsView {...props()} />);

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
    render(<AppsView {...props()} />);

    const message = "Warning: dohc.json could not be parsed (client-portal/dohc.json)";
    const mark = await screen.findByRole("img", { name: message });
    expect(mark.getAttribute("data-testid")).toBe("sites-diagnostic-indicator");
    expect(mark.getAttribute("title")).toBe(message);
  });

  it("marks low-confidence app detections", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({
      sites: [{ ...app, confidence: "low" }],
    });
    render(<AppsView {...props()} />);

    await screen.findByText("Client Portal");
    expect(screen.getByTestId("sites-low-confidence").getAttribute("aria-label")).toBe(
      "Low confidence detection",
    );
  });

  it("keeps a pinned app's pin in view and hides the others until hover or focus", async () => {
    bridgeMock.listSites.mockResolvedValueOnce({
      sites: [app, { ...app, root: "docs", title: "Docs" }],
    });
    render(<AppsView {...props({ pinnedApps: ["client-portal"] })} />);

    const pinned = await screen.findByRole("button", { name: "Unpin" });
    const unpinned = screen.getByRole("button", { name: "Pin to sidebar" });
    expect(pinned.className).not.toContain("opacity-0");
    expect(pinned.querySelector("svg")?.getAttribute("class")).toContain("text-ink");
    expect(unpinned.className).toContain("opacity-0");
    expect(unpinned.className).toContain("group-has-[:focus-visible]:opacity-100");
  });
});
