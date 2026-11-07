// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppViewRequest, WorkspaceUiState } from "../ipc/bridgeContract";
import { editorTabTestId } from "../testPins";
import { SAVED_TABS_RESTORE } from "./shell/useSavedTabsReread";
import type { ExplorerProps } from "./workbench/Explorer";
import { siteTabPath } from "./workbench/workbenchState";
import { STORED_STATE, WORKSPACE, makeBridge, renderShell } from "./DesktopWorkspaceShell.testHarness";

const requested = vi.hoisted(() => ({ path: "" }));
vi.mock("./workbench/Explorer", () => ({
  Explorer: (props: Pick<ExplorerProps, "onOpenFile">) => (
    <button onClick={() => props.onOpenFile(requested.path)}>Open test tab</button>
  ),
}));
vi.mock("./FileInspector", () => ({
  FileInspector: (props: { path: string }) => <div data-testid="file-inspector" data-path={props.path} />,
}));
// The app's real view hook, so each open and close reaches the bridge as it does from the app's tab. The button
// stands in for the page's toolbar. A static site under sites/ shows its preview in an iframe instead, with Logs after it.
vi.mock("./SitePreviewPage", async () => {
  const { AppViewBody, useAppView } = await import("./AppView");
  return {
    SitePreviewPage: (props: { workspaceId: string; siteRoot: string; visible?: boolean; focused?: boolean; focusRequest?: number }) => {
      const isStatic = props.siteRoot.startsWith("sites/");
      const view = useAppView({
        workspaceId: props.workspaceId, appRoot: props.siteRoot, enabled: !isStatic,
        visible: props.visible ?? true, focused: props.focused ?? false, focusRequest: props.focusRequest ?? 0, approvals: 0, holdFocus: false,
      });
      return (
        <div data-testid="site-preview-page" data-root={props.siteRoot}>
          <button type="button">Reload app</button>
          {isStatic ? (
            <>
              <iframe data-testid="site-preview-frame" title="Notes site" />
              <details><summary>Logs</summary></details>
            </>
          ) : <AppViewBody view={view} onReview={() => undefined} />}
        </div>
      );
    },
  };
});

const trip = siteTabPath("apps/trip");
const shop = siteTabPath("apps/shop");

function appBridge(state: Promise<WorkspaceUiState | null>) {
  let launches = 0;
  return Object.assign(makeBridge(state), {
    appView: vi.fn(async (request: AppViewRequest) => {
      if (request.action === "open") {
        return { kind: "opened" as const, viewId: request.viewId, publicationId: "d".repeat(64),
          url: `http://127.0.0.1:4310${++launches}/`, partition: `dohc-app-view-${request.viewId}` };
      }
      if (request.action === "close") return { kind: "closed" as const, viewId: request.viewId };
      return { kind: "colorScheme" as const };
    }),
    onAppViewEvent: vi.fn(() => () => undefined),
  });
}
type AppBridge = ReturnType<typeof appBridge>;

// What the app views asked main for, in order. A move asks for nothing.
const lifecycle = (bridge: AppBridge) => bridge.appView.mock.calls.flatMap(([request]) =>
  request.action === "open" || request.action === "close" ? [`${request.action} ${request.viewId}`] : []);
const viewIdOf = (bridge: AppBridge, root: string) => bridge.appView.mock.calls.flatMap(([request]) =>
  request.action === "open" && request.appRoot === root ? [request.viewId] : [])[0];
const webviewOf = (root: string) => document.querySelector<HTMLElement>(
  `[data-testid="site-preview-page"][data-root="${root}"] [data-testid="app-view-webview"]`);
async function openedWebview(root: string): Promise<HTMLElement> {
  return waitFor(() => {
    const webview = webviewOf(root);
    expect(webview).not.toBeNull();
    return webview!;
  });
}
// The placed page an app's webview sits in, and the group it lies over.
const pageOf = (webview: HTMLElement) => webview.closest<HTMLElement>("[data-app-group-id]")!;
function expectShownIn(webview: HTMLElement, group: HTMLElement) {
  const page = pageOf(webview);
  expect(page.dataset.appGroupId).toBe(group.dataset.editorGroupId);
  expect(page.classList.contains("hidden")).toBe(false);
  // The group's slot names the page, for its place and for assistive technology.
  const slot = within(group).getByTestId("app-slot");
  expect(document.getElementById(slot.getAttribute("aria-owns")!)).toBe(page);
}
function stubPointer(target: () => Element | null) {
  Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(Element.prototype, "hasPointerCapture", { configurable: true, value: vi.fn(() => false) });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(target) });
}
function dragTab(tab: HTMLElement) {
  fireEvent.pointerDown(tab, { button: 0, pointerId: 7, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(tab, { buttons: 1, pointerId: 7, clientX: 30, clientY: 40 });
  fireEvent.pointerUp(tab, { pointerId: 7, clientX: 30, clientY: 40 });
}

describe("an app's page when its tab moves", () => {
  it("keeps the page, and the page the target group shows, when the tab is dragged there", async () => {
    const bridge = appBridge(Promise.resolve({
      ...STORED_STATE,
      editorGroups: [
        { id: "left", tabs: ["notes.txt", trip], activeTab: trip, size: 0.5 },
        { id: "right", tabs: [shop], activeTab: shop, size: 0.5 },
      ],
      activeEditorGroup: "left",
    }));
    renderShell(bridge);
    const tripView = await openedWebview("apps/trip");
    const shopView = await openedWebview("apps/shop");
    const opened = lifecycle(bridge);
    expect([...opened].sort()).toEqual([`open ${viewIdOf(bridge, "apps/trip")}`, `open ${viewIdOf(bridge, "apps/shop")}`].sort());
    const left = screen.getByTestId("editor-group-left");
    const right = screen.getByTestId("editor-group-right");
    expectShownIn(tripView, left);
    expectShownIn(shopView, right);

    // The drop lands on the other app's page, which lies over the target group.
    stubPointer(() => shopView);
    dragTab(within(left).getByTestId(editorTabTestId(trip)));

    await waitFor(() => expect(within(right).getByTestId(editorTabTestId(trip))).toBeTruthy());
    expect(within(left).queryByTestId(editorTabTestId(trip))).toBeNull();
    expect(webviewOf("apps/trip")).toBe(tripView);
    expect(webviewOf("apps/shop")).toBe(shopView);
    expect(tripView.isConnected && shopView.isConnected).toBe(true);
    expectShownIn(tripView, right);
    expect(pageOf(shopView).classList.contains("hidden")).toBe(true);
    expect(lifecycle(bridge)).toEqual(opened);

    // Switching back shows the other app's same page.
    const shopTab = within(right).getByTestId(editorTabTestId(shop));
    fireEvent.pointerDown(shopTab, { button: 0, pointerId: 8, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(shopTab, { pointerId: 8, clientX: 10, clientY: 10 });
    await waitFor(() => expect(pageOf(shopView).classList.contains("hidden")).toBe(false));
    expect(webviewOf("apps/shop")).toBe(shopView);
    expect(pageOf(tripView).classList.contains("hidden")).toBe(true);
    expect(lifecycle(bridge)).toEqual(opened);
  });

  it("keeps the page when its tab moves into a new group", async () => {
    const bridge = appBridge(Promise.resolve({
      ...STORED_STATE,
      editorGroups: [{ id: "primary", tabs: ["notes.txt", trip], activeTab: trip, size: 1 }],
      activeEditorGroup: "primary",
    }));
    bridge.showWorkbenchMenu.mockResolvedValue("move-tab-to-new-group");
    renderShell(bridge);
    const tripView = await openedWebview("apps/trip");
    const opened = lifecycle(bridge);

    fireEvent.contextMenu(screen.getByTestId(editorTabTestId(trip)));

    const split = await screen.findByRole("region", { name: "Editor group 2" });
    await waitFor(() => expect(within(split).getByTestId(editorTabTestId(trip))).toBeTruthy());
    expect(webviewOf("apps/trip")).toBe(tripView);
    expectShownIn(tripView, split);
    expect(lifecycle(bridge)).toEqual(opened);
  });

  it("keeps the page when its group takes another place in the layout", async () => {
    const bridge = appBridge(Promise.resolve({
      ...STORED_STATE,
      editorGroups: [
        // Only an empty group shows its own close control.
        { id: "left", tabs: [], activeTab: null, size: 0.5 },
        { id: "right", tabs: [trip], activeTab: trip, size: 0.5 },
      ],
      activeEditorGroup: "right",
    }));
    renderShell(bridge);
    const tripView = await openedWebview("apps/trip");
    const opened = lifecycle(bridge);
    const right = screen.getByTestId("editor-group-right");
    expect(right.getAttribute("aria-label")).toBe("Editor group 2");
    expectShownIn(tripView, right);

    fireEvent.click(within(screen.getByTestId("editor-group-left")).getByRole("button", { name: "Close editor group" }));

    await waitFor(() => expect(screen.queryByTestId("editor-group-left")).toBeNull());
    expect(right.getAttribute("aria-label")).toBe("Editor group 1");
    expect(webviewOf("apps/trip")).toBe(tripView);
    expectShownIn(tripView, right);
    expect(lifecycle(bridge)).toEqual(opened);
  });

  it("keeps the page when Restore tabs moves it out of a group the saved layout lacks", async () => {
    const bridge = appBridge(Promise.resolve(STORED_STATE));
    bridge.getWorkspaceUiState
      .mockRejectedValueOnce(new Error("dohc has not finished opening this workspace."))
      .mockRejectedValueOnce(new Error("dohc has not finished opening this workspace."));
    bridge.showWorkbenchMenu.mockResolvedValue("move-tab-to-new-group");
    const user = userEvent.setup();
    renderShell(bridge);
    await waitFor(() => expect(bridge.getWorkspaceUiState).toHaveBeenCalledTimes(2));
    requested.path = "notes.txt";
    await user.click(screen.getByRole("button", { name: "Open test tab" }));
    requested.path = trip;
    await user.click(screen.getByRole("button", { name: "Open test tab" }));
    const tripView = await openedWebview("apps/trip");
    fireEvent.contextMenu(screen.getByTestId(editorTabTestId(trip)));
    const split = await screen.findByRole("region", { name: "Editor group 2" });
    await waitFor(() => expect(within(split).getByTestId(editorTabTestId(trip))).toBeTruthy());
    expect(STORED_STATE.editorGroups.map((group) => group.id)).not.toContain(split.dataset.editorGroupId);
    const opened = lifecycle(bridge);
    expect(opened).toEqual([`open ${viewIdOf(bridge, "apps/trip")}`]);

    act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId }));
    await user.click(screen.getByTestId("notice-center-toggle"));
    const row = (await within(screen.getByTestId("notice-center")).findByText(SAVED_TABS_RESTORE)).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Restore tabs" }));

    const primary = screen.getByTestId("editor-group-primary");
    await waitFor(() => expect(within(primary).getByTestId(editorTabTestId("b.md"))).toBeTruthy());
    await waitFor(() => expect(within(primary).getByTestId(editorTabTestId(trip))).toBeTruthy());
    expect(webviewOf("apps/trip")).toBe(tripView);
    expectShownIn(tripView, primary);
    expect(lifecycle(bridge)).toEqual(opened);
  });

  it("closes the page when its tab closes", async () => {
    const bridge = appBridge(Promise.resolve({
      ...STORED_STATE,
      editorGroups: [{ id: "primary", tabs: ["notes.txt", trip], activeTab: trip, size: 1 }],
      activeEditorGroup: "primary",
    }));
    renderShell(bridge);
    await openedWebview("apps/trip");
    const viewId = viewIdOf(bridge, "apps/trip");

    fireEvent.click(within(screen.getByTestId(editorTabTestId(trip))).getByRole("button", { name: /^Close / }));

    await waitFor(() => expect(lifecycle(bridge)).toEqual([`open ${viewId}`, `close ${viewId}`]));
    expect(webviewOf("apps/trip")).toBeNull();
  });
});

// Tab as the browser runs it: keydown, then, unless a handler prevented it, focus moves on from wherever it is now.
// jsdom has no guest page, so the walk stands in for one: Tab onto a webview or a preview iframe enters its guest,
// the guest's keys never reach dohc, and leaving the guest goes on from the frame element in document order.
const FRAME = "webview, iframe";
const TABBABLE = `a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), details > summary:first-of-type, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"]), ${FRAME}`;
const tabbables = () => [...document.querySelectorAll<HTMLElement>(TABBABLE)]
  .filter((element) => !element.closest("[data-app-group-id].hidden, [hidden], [inert]"));
function keyboard() {
  let guest: HTMLElement | null = null;
  let prevented = 0;
  const focused = () => guest ?? (document.activeElement as HTMLElement);
  const tab = (shiftKey: boolean) => {
    if (!guest && !fireEvent.keyDown(focused(), { key: "Tab", shiftKey })) {
      prevented += 1;
      return focused();
    }
    const order = tabbables();
    const next = order[(order.indexOf(focused()) + (shiftKey ? order.length - 1 : 1)) % order.length]!;
    guest = null;
    if (next.matches(FRAME)) guest = next;
    else act(() => next.focus());
    return focused();
  };
  return { tab, prevented: () => prevented };
}
function where(element: HTMLElement): string {
  if (!element.closest("main")) return "outside";
  const page = element.closest<HTMLElement>("[data-app-group-id]");
  if (page) return `${element.matches(FRAME) ? "guest" : "app"} ${page.dataset.appGroupId}`;
  const group = element.closest<HTMLElement>("[data-editor-group-id]");
  if (group) return `group ${group.dataset.editorGroupId}`;
  return element.getAttribute("role") === "separator" ? "separator" : "main";
}
// Tab from the first group's first control until focus leaves the editor area, then Shift+Tab back as many times.
function walk(groupId: string) {
  const first = tabbables().find((element) => screen.getByTestId(`editor-group-${groupId}`).contains(element))!;
  const keys = keyboard();
  act(() => first.focus());
  const forward = [first];
  while (where(forward[forward.length - 1]!) !== "outside" && forward.length < 200) forward.push(keys.tab(false));
  const backward = [forward[forward.length - 1]!];
  while (backward.length < forward.length) backward.push(keys.tab(true));
  // Focus never rests on a stop, reaches each control once, and Shift+Tab retraces Tab exactly.
  expect(forward.filter((element) => element.matches("[data-app-stop]"))).toEqual([]);
  expect(new Set(forward).size).toBe(forward.length);
  expect(backward.map((element) => forward.indexOf(element))).toEqual(forward.map((_, index) => forward.length - 1 - index));
  return { regions: forward.map(where).filter((region, index, all) => region !== all[index - 1]), forward, keys };
}
async function renderSplit(editorGroups: WorkspaceUiState["editorGroups"], appRoots: string[]) {
  renderShell(appBridge(Promise.resolve({ ...STORED_STATE, editorGroups, activeEditorGroup: editorGroups[0]!.id })));
  for (const root of appRoots) await openedWebview(root);
}

describe("Tab order with an app beside another group", () => {
  it("goes through each group's app before the next group, both ways, in two groups", async () => {
    await renderSplit([
      { id: "left", tabs: ["notes.txt", trip], activeTab: trip, size: 0.5 },
      { id: "right", tabs: ["notes.txt"], activeTab: "notes.txt", size: 0.5 },
    ], ["apps/trip"]);
    const { regions } = walk("left");
    expect(regions).toEqual(["group left", "app left", "guest left", "separator", "group right", "outside"]);
  });

  it("goes through each group's app before the next group, both ways, in three groups", async () => {
    await renderSplit([
      { id: "left", tabs: [trip], activeTab: trip, size: 1 / 3 },
      { id: "middle", tabs: ["notes.txt"], activeTab: "notes.txt", size: 1 / 3 },
      { id: "right", tabs: [shop], activeTab: shop, size: 1 / 3 },
    ], ["apps/trip", "apps/shop"]);
    const { regions } = walk("left");
    expect(regions).toEqual([
      "group left", "app left", "guest left", "separator", "group middle",
      "separator", "group right", "app right", "guest right", "outside",
    ]);
  });

  it("goes through a static site's preview before the next group, both ways", async () => {
    await renderSplit([
      { id: "left", tabs: [siteTabPath("sites/notes")], activeTab: siteTabPath("sites/notes"), size: 0.5 },
      { id: "right", tabs: ["notes.txt"], activeTab: "notes.txt", size: 0.5 },
    ], []);
    await waitFor(() => expect(document.querySelector('[data-root="sites/notes"] [data-testid="site-preview-frame"]')).not.toBeNull());
    const { regions } = walk("left");
    // The preview's Logs control follows its frame.
    expect(regions).toEqual(["group left", "app left", "guest left", "app left", "separator", "group right", "outside"]);
  });

  it("adds no stop to the order with one group", async () => {
    await renderSplit([{ id: "primary", tabs: ["notes.txt", trip], activeTab: trip, size: 1 }], ["apps/trip"]);
    const { regions, forward, keys } = walk("primary");
    expect(regions).toEqual(["group primary", "app primary", "guest primary", "outside"]);
    // Tab moves as it would with no app routing at all: nothing is prevented, and focus visits the document's
    // own order with the page's end stop left out.
    expect(keys.prevented()).toBe(0);
    const plain = tabbables().filter((element) => !element.matches("[data-app-stop]"));
    const start = plain.indexOf(forward[0]!);
    expect(forward.map((element) => plain.indexOf(element))).toEqual(forward.map((_, index) => (start + index) % plain.length));
  });

  it("goes back into a page that ends in a control, with one group", async () => {
    const notes = siteTabPath("sites/notes");
    await renderSplit([{ id: "primary", tabs: [notes], activeTab: notes, size: 1 }], []);
    await waitFor(() => expect(document.querySelector('[data-root="sites/notes"] [data-testid="site-preview-frame"]')).not.toBeNull());
    // Shift+Tab from outside the editor area reaches the preview's Logs control, not the page's end stop.
    const { regions } = walk("primary");
    expect(regions).toEqual(["group primary", "app primary", "guest primary", "app primary", "outside"]);
  });
});
