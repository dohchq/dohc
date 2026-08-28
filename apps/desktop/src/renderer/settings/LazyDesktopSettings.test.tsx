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

function RecoveredSettings(_props: DesktopSettingsProps) {
  return <div data-testid="settings-dialog">Settings ready</div>;
}

function settingsProps(): DesktopSettingsProps {
  return {
    workspaceId: "workspace-1",
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
      '[data-dohc-modal="true"] > div',
    );
    expect(document.activeElement).toBe(panel);

    await act(async () => {
      resolve({ default: RecoveredSettings });
      await pending;
    });
    expect(await screen.findByTestId("settings-dialog")).toBeTruthy();
  });
});
