// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SitePackageInfo } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { AppsSettings } from "./AppsSettings";

const base: SitePackageInfo = {
  root: "report",
  title: "Report",
  kind: "static",
  confidence: "high",
  entryPath: "report/index.html",
  configPath: null,
  packagePath: null,
  packageManager: null,
  scripts: {},
  configuredScripts: {},
  configuredPreviewMode: null,
  configuredBuildOutput: null,
  buildOutputs: [],
  sourceFiles: ["report/index.html"],
  shareManifest: { ok: true, manifest: { entryPath: "report/index.html", assets: [] } },
  diagnostics: [],
  authority: { kind: "workspace" },
};

const trip: SitePackageInfo = {
  ...base,
  root: "apps/trip",
  title: "Trip planner",
  kind: "package",
  entryPath: null,
  packagePath: "apps/trip/package.json",
  packageManager: "pnpm",
  scripts: { dev: "vite", build: "vite build" },
  sourceFiles: ["apps/trip/package.json"],
};

const signup: SitePackageInfo = {
  ...trip,
  root: "apps/signup",
  title: "Signup",
  kind: "configured",
  configPath: "apps/signup/dohc.json",
  packagePath: "apps/signup/package.json",
  configuredPreviewMode: "build",
  diagnostics: [{ severity: "warning", code: "x", message: "The build output is older than its source.", path: "apps/signup/dist" }],
};

const bridge = {
  listSites: vi.fn(async (_payload: { workspaceId: string }) => ({ sites: [base, trip, signup] })),
};

function renderApps(overrides: Partial<Parameters<typeof AppsSettings>[0]> = {}) {
  const props: Parameters<typeof AppsSettings>[0] = {
    workspaceId: "ws-1",
    sharedView: false,
    defaultPreviewMode: "auto",
    defaultModified: false,
    onDefaultChange: vi.fn(),
    onDefaultReset: vi.fn(),
    trust: { trusted: true, onOpen: vi.fn() },
    pinned: [],
    onSetPinned: vi.fn(),
    onOpenApp: vi.fn(),
    onError: vi.fn(),
    onClearError: vi.fn(),
    ...overrides,
  };
  return { props, view: render(<AppsSettings {...props} />) };
}

const modeOf = async (root: string) => {
  const row = await screen.findByRole("button", { name: rootTitle[root] });
  return within(row).getByTestId("settings-app-mode").textContent;
};
const rootTitle: Record<string, string> = { report: "Report", "apps/trip": "Trip planner", "apps/signup": "Signup" };

beforeEach(() => {
  window.localStorage.clear();
  bridge.listSites.mockImplementation(async () => ({ sites: [base, trip, signup] }));
  vi.stubGlobal("dohcDesktop", bridge);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("AppsSettings", () => {
  it("lists each app with the mode its preview starts in and why", async () => {
    window.localStorage.setItem("dohc.site-preview-mode.v1:ws-1:report", "static");
    renderApps({ defaultPreviewMode: "build" });
    expect(await modeOf("report")).toBe("StaticPicked on this computer");
    // The workspace default wins over dohc's own pick.
    expect(await modeOf("apps/trip")).toBe("BuildWorkspace default");
    expect(await modeOf("apps/signup")).toBe("BuildSet in dohc.json");
  });

  it("falls back to dohc's pick when the workspace default does not fit an app", async () => {
    renderApps({ defaultPreviewMode: "static" });
    // Trip planner has no static entry, so dohc picks Dev for it.
    expect(await modeOf("apps/trip")).toBe("DevAutomatic");
  });

  it("opens an app's page, picks a mode on this computer, and puts it back to Default", async () => {
    const user = userEvent.setup();
    renderApps();
    await user.click(await screen.findByRole("button", { name: "Trip planner" }));

    const page = screen.getByTestId("settings-app-page");
    expect(document.activeElement).toBe(screen.getByTestId("settings-app-back"));
    const startWith = within(page).getByTestId("settings-app-start-with");
    expect(startWith.textContent).toContain("Default starts Dev, which dohc picks for this app.");
    const control = within(page).getByTestId("settings-app-mode-control");
    expect(within(control).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Default", "Dev", "Build"]);

    await user.click(within(control).getByRole("radio", { name: "Build" }));
    expect(window.localStorage.getItem("dohc.site-preview-mode.v1:ws-1:apps/trip")).toBe("build");
    expect(startWith.textContent).toContain("Picked on this computer.");

    await user.click(within(control).getByRole("radio", { name: "Default" }));
    expect(window.localStorage.getItem("dohc.site-preview-mode.v1:ws-1:apps/trip")).toBeNull();

    await user.click(screen.getByTestId("settings-app-back"));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Trip planner" }));
    expect(await modeOf("apps/trip")).toBe("DevAutomatic");
  });

  it("shows an app's files, scripts and problems", async () => {
    const user = userEvent.setup();
    renderApps();
    await user.click(await screen.findByRole("button", { name: "Signup" }));
    const details = screen.getByTestId("settings-app-details");
    expect([...details.querySelectorAll("dt")].map((term) => term.textContent))
      .toEqual(["Folder", "Settings file", "Package", "Dev script", "Build script"]);
    expect(details.textContent).toContain("apps/signup/package.json (pnpm)");
    expect(screen.getByTestId("settings-app-start-with").textContent).toContain("Default starts Build, as its dohc.json sets.");
    expect(screen.getByTestId("settings-app-problems").textContent)
      .toBe("The build output is older than its source.apps/signup/dist");
  });

  it("pins and opens an app from its page", async () => {
    const user = userEvent.setup();
    const { props } = renderApps({ pinned: ["apps/trip"] });
    await user.click(await screen.findByRole("button", { name: "Trip planner" }));
    const pin = screen.getByRole("switch", { name: "Pin Trip planner to sidebar" });
    expect(pin.getAttribute("aria-checked")).toBe("true");
    await user.click(pin);
    expect(props.onSetPinned).toHaveBeenCalledWith("apps/trip", false);
    await user.click(screen.getByTestId("settings-app-open"));
    expect(props.onOpenApp).toHaveBeenCalledWith("apps/trip");
  });

  it("says when Restricted Mode holds the mode an app starts in", async () => {
    const user = userEvent.setup();
    renderApps({ trust: { trusted: false, onOpen: vi.fn() } });
    await user.click(await screen.findByRole("button", { name: "Trip planner" }));
    expect(screen.getByTestId("settings-app-restricted").textContent)
      .toBe("Restricted Mode holds Dev until you trust this workspace.");
    await user.click(within(screen.getByTestId("settings-app-mode-control")).getByRole("radio", { name: "Build" }));
    expect(screen.getByTestId("settings-app-restricted").textContent)
      .toBe("Restricted Mode holds Build until you trust this workspace.");
  });

  it("says when the workspace has no apps", async () => {
    bridge.listSites.mockResolvedValueOnce({ sites: [] });
    renderApps();
    expect((await screen.findByTestId("settings-apps-empty")).textContent).toBe("No apps in this workspace yet.");
  });

  it("reports a failed list once and lists again on Try again", async () => {
    const user = userEvent.setup();
    bridge.listSites.mockRejectedValueOnce(new Error("boom"));
    const { props } = renderApps();
    const failed = await screen.findByTestId("settings-apps-failed");
    expect(props.onError).toHaveBeenCalledOnce();
    expect(vi.mocked(props.onError!).mock.calls[0]![4]).toBe("settings-apps:ws-1");
    await user.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Trip planner" })).toBeTruthy();
    expect(props.onClearError).toHaveBeenCalledWith("settings-apps:ws-1");
  });

  it("never shows one workspace's apps on another's page", async () => {
    const slow = deferred<{ sites: SitePackageInfo[] }>();
    bridge.listSites.mockImplementationOnce(() => slow.promise);
    bridge.listSites.mockImplementationOnce(async () => ({ sites: [base] }));
    const { props, view } = renderApps();
    view.rerender(<AppsSettings {...props} workspaceId="ws-2" />);
    expect(await screen.findByRole("button", { name: "Report" })).toBeTruthy();
    await act(async () => {
      slow.resolve({ sites: [trip] });
      await slow.promise;
    });
    expect(bridge.listSites).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Trip planner" })).toBeNull();
  });
});
