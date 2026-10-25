// @vitest-environment jsdom
import {
  act,
  cleanup,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Overlay } from "../Overlay";
import {
  LazyDesktopSettings,
  type DesktopSettingsProps,
} from "./LazyDesktopSettings";

vi.mock("./SettingsDialog", () => ({
  SettingsDialog: () => <div data-testid="settings-dialog">Settings ready</div>,
}));

function RecoveredSettings(_props: DesktopSettingsProps) {
  return <div data-testid="settings-dialog">Settings ready</div>;
}

function settingsProps(): DesktopSettingsProps {
  return {
    workspaceId: "workspace-1",
    workspaceIsReady: true,
    workspacePath: "C:\\workspace-1",
    onClose: () => undefined,
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LazyDesktopSettings", () => {
  it("contains a rejected import and retries with a fresh lazy component", async () => {
    let attempt = 0;
    const loader = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("settings chunk unavailable");
      return { default: RecoveredSettings };
    });

    render(
      <div>
        <div data-testid="workspace">Workspace remains usable</div>
        <Overlay onClose={() => undefined}>
          <LazyDesktopSettings {...settingsProps()} loader={loader} />
        </Overlay>
      </div>,
    );

    expect(await screen.findByTestId("error-boundary-settings")).toBeTruthy();
    expect(screen.getByTestId("workspace")).toBeTruthy();
    expect(screen.queryByTestId("app-crash-screen")).toBeNull();

    await userEvent.click(screen.getByTestId("error-boundary-settings-retry"));

    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("shows the dialog scaffold and moves focus off obscured controls while loading", async () => {
    let resolve!: (module: { default: typeof RecoveredSettings }) => void;
    const pending = new Promise<{ default: typeof RecoveredSettings }>((done) => {
      resolve = done;
    });
    const loader = vi.fn(() => pending);

    render(
      <Overlay onClose={() => undefined}>
        <LazyDesktopSettings {...settingsProps()} loader={loader} />
      </Overlay>,
    );

    expect(screen.getByTestId("settings-loading").textContent).toBe(
      "Loading settings...",
    );
    const panel = document.querySelector<HTMLElement>(
      '[data-dohc-modal="true"] > [data-focus-surface="dialog"]',
    );
    expect(document.activeElement).toBe(panel);

    await act(async () => {
      resolve({ default: RecoveredSettings });
      await pending;
    });
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
  });

  it("closes from its X while loading and after a failed load", async () => {
    const onClose = vi.fn();
    const pending = render(
      <LazyDesktopSettings {...settingsProps()} onClose={onClose} loader={() => new Promise(() => undefined)} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    pending.unmount();

    render(
      <LazyDesktopSettings {...settingsProps()} onClose={onClose} loader={async () => { throw new Error("settings chunk unavailable"); }} />,
    );
    await screen.findByTestId("error-boundary-settings");
    await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("reopens without the loading skeleton once the chunk has loaded", async () => {
    const first = render(<LazyDesktopSettings {...settingsProps()} />);
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
    first.unmount();

    const observer = new MutationObserver(() => undefined);
    observer.observe(document.body, { childList: true, subtree: true });
    render(<LazyDesktopSettings {...settingsProps()} />);
    const added = observer.takeRecords().flatMap((record) => [...record.addedNodes]);
    observer.disconnect();

    expect(
      screen.queryByTestId("settings-dialog"),
      "a fresh lazy per mount suspends again and shows the skeleton for a module already loaded",
    ).toBeTruthy();
    expect(
      added.some(
        (node) =>
          node instanceof Element &&
          (node.matches('[data-testid="settings-loading"]') ||
            node.querySelector('[data-testid="settings-loading"]') !== null),
      ),
    ).toBe(false);
  });
});
