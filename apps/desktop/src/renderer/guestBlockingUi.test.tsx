// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginWebAppFailedEvent,
  SetPluginWebAppBoundsPayload,
  StartPluginWebAppResult,
} from "../ipc/bridgeContract";
import { useGuestBlockingUi, useGuestBlockingUiWhile } from "./guestBlockingUi";
import { Overlay } from "./Overlay";
import { PluginWebAppPage } from "./PluginWebAppPage";

// The signal that hides a plugin web app's guest, driven the way the shell
// drives it. The guest is a main-process view composited above this renderer,
// so anything painted in its rectangle looks clickable and is not.

const bridgeMock = {
  startPluginWebApp: vi.fn(async (): Promise<StartPluginWebAppResult> => ({
    status: "ok",
    title: "T3 Code",
    origin: "http://127.0.0.1:49160",
  })),
  setPluginWebAppBounds: vi.fn(
    async (_payload: SetPluginWebAppBoundsPayload) => undefined,
  ),
  stopPluginWebApp: vi.fn(async () => undefined),
  onPluginWebAppFailed: vi.fn(
    (_listener: (event: PluginWebAppFailedEvent) => void) => () => undefined,
  ),
};

const RECT = {
  x: 10,
  y: 20,
  width: 640,
  height: 480,
  top: 20,
  left: 10,
  right: 650,
  bottom: 500,
  toJSON: () => ({}),
} as DOMRect;

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * The shell in miniature: an open web app tab reading the shared signal, plus
 * a child that owns its own confirm state — the shape the history diff page's
 * restore confirm has. The shell cannot see that state, which is why the
 * signal is a registry and not a list of the shell's own flags.
 */
function Shell(props: { children?: React.ReactNode }) {
  const overlayOpen = useGuestBlockingUi();
  return (
    <div>
      <PluginWebAppPage
        workspaceId="ws-1"
        pluginId="t3-code"
        webAppId="app"
        hiddenByOverlay={overlayOpen}
      />
      {props.children}
    </div>
  );
}

function RestoreConfirmHost() {
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setConfirmRestoreOpen(true)}>
        Restore
      </button>
      {confirmRestoreOpen ? (
        <Overlay onClose={() => setConfirmRestoreOpen(false)}>
          <div data-testid="engine-diff-restore-confirm" role="dialog" aria-modal="true">
            <button type="button" onClick={() => setConfirmRestoreOpen(false)}>
              Cancel
            </button>
          </div>
        </Overlay>
      ) : null}
    </>
  );
}

function FloatingAsk(props: { pending: boolean }) {
  useGuestBlockingUiWhile(props.pending);
  return props.pending ? <div data-testid="floating-ask">Allow?</div> : null;
}

const lastVisible = () =>
  bridgeMock.setPluginWebAppBounds.mock.calls.at(-1)?.[0]?.visible;

describe("the guest-blocking UI signal", () => {
  beforeEach(() => {
    vi.stubGlobal("dohcDesktop", bridgeMock);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(RECT);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("hides the guest for an overlay the shell cannot see", async () => {
    render(
      <Shell>
        <RestoreConfirmHost />
      </Shell>,
    );
    await screen.findByTestId("plugin-web-app-frame");
    expect(lastVisible()).toBe(true);

    // MUTATION (Overlay stops registering, or the shell goes back to listing
    // its own flags): this confirm paints over the guest, the guest keeps
    // compositing above it, and "Restore this file?" cannot be answered.
    await act(async () => {
      screen.getByText("Restore").click();
      await Promise.resolve();
    });
    expect(screen.getByTestId("engine-diff-restore-confirm")).toBeTruthy();
    expect(lastVisible()).toBe(false);

    await act(async () => {
      screen.getByText("Cancel").click();
      await Promise.resolve();
    });
    expect(lastVisible()).toBe(true);
  });

  it("hides the guest for a floating ask that is not an overlay", async () => {
    const view = render(
      <Shell>
        <FloatingAsk pending={false} />
      </Shell>,
    );
    await screen.findByTestId("plugin-web-app-frame");
    expect(lastVisible()).toBe(true);

    // MUTATION (drop the registration): an agent permission card floats over
    // the guest, its Allow button eats nothing, and the run stays blocked
    // with no way to unblock it.
    await act(async () => {
      view.rerender(
        <Shell>
          <FloatingAsk pending />
        </Shell>,
      );
      await Promise.resolve();
    });
    expect(lastVisible()).toBe(false);

    await act(async () => {
      view.rerender(
        <Shell>
          <FloatingAsk pending={false} />
        </Shell>,
      );
      await Promise.resolve();
    });
    expect(lastVisible()).toBe(true);
  });

  it("keeps the guest hidden until the last blocker leaves", async () => {
    const view = render(
      <Shell>
        <RestoreConfirmHost />
        <FloatingAsk pending />
      </Shell>,
    );
    await screen.findByTestId("plugin-web-app-frame");
    expect(lastVisible()).toBe(false);

    await act(async () => {
      screen.getByText("Restore").click();
      await Promise.resolve();
    });
    await act(async () => {
      screen.getByText("Cancel").click();
      await Promise.resolve();
    });
    // The floating ask is still up: one blocker leaving is not all of them.
    expect(lastVisible()).toBe(false);

    await act(async () => {
      view.rerender(
        <Shell>
          <RestoreConfirmHost />
          <FloatingAsk pending={false} />
        </Shell>,
      );
      await Promise.resolve();
    });
    expect(lastVisible()).toBe(true);
  });

  it("leaves Escape to the topmost overlay, not to a floating ask", async () => {
    const closed: string[] = [];
    function Nested() {
      return (
        <>
          <Overlay onClose={() => closed.push("outer")}>
            <div>outer</div>
          </Overlay>
          <Overlay onClose={() => closed.push("inner")}>
            <div>inner</div>
          </Overlay>
          <FloatingAsk pending />
        </>
      );
    }
    render(<Nested />);

    // MUTATION (register the floating ask in the Escape stack too): the
    // topmost overlay stops answering Escape while a card floats over it.
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(closed).toEqual(["inner"]);
  });
});
