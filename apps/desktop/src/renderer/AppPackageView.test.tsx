// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPackageResult, AppRuntimeResult } from "../ipc/bridgeContract";
import { AppPackageView, isRuntimeMessage } from "./AppPackageView";

const readyInfo: NonNullable<AppPackageResult> = {
  name: "ledger",
  root: "finance/.apps/ledger",
  manifest: {
    title: "Ledger",
    entry: "src/App.tsx",
    read: ["transactions/**"],
    write: ["transactions/**"],
    network: false,
  },
  sourceFiles: ["finance/.apps/ledger/app.json", "finance/.apps/ledger/src/App.tsx"],
  requiresTrust: true,
  trusted: true,
  readiness: "ready",
  lastTestChecks: [{ name: "compile", status: "ok" }],
};

const runtime: AppRuntimeResult = {
  root: "finance/.apps/ledger",
  title: "Ledger",
  token: "runtime-token",
  src: "http://127.0.0.1:4477/runtime-token/index.html",
};

const bridgeMock = {
  getAppPackage: vi.fn(async () => readyInfo),
  runAppTester: vi.fn(),
  grantAppTrust: vi.fn(),
  getAppRuntime: vi.fn(async () => runtime),
  // Main wraps runtime RPC results in `{ value }` before returning through IPC.
  runAppRuntimeRpc: vi.fn(async () => ({ value: { row: { id: "x" } } })),
};

vi.mock("./bridge", () => ({
  bridge: () => bridgeMock,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AppPackageView runtime frame", () => {
  it("accepts only token-bound, op-shaped runtime messages", () => {
    expect(
      isRuntimeMessage(
        {
          type: "dohc:runtime-rpc",
          token: "runtime-token",
          id: "1",
          op: "collection.insert",
          args: { name: "transactions", record: { id: "x" } },
        },
        "runtime-token",
      ),
    ).toBe(true);
    expect(
      isRuntimeMessage(
        {
          type: "dohc:runtime-rpc",
          token: "runtime-token",
          id: "2",
          op: "collection.list",
          args: { name: "transactions" },
        },
        "runtime-token",
      ),
    ).toBe(true);
    expect(
      isRuntimeMessage(
        {
          type: "dohc:runtime-rpc",
          token: "wrong-token",
          id: "bad",
          op: "collection.insert",
          args: { name: "transactions", record: { id: "x" } },
        },
        "runtime-token",
      ),
    ).toBe(false);
    expect(
      isRuntimeMessage(
        {
          type: "dohc:runtime-rpc",
          token: "runtime-token",
          id: "bad",
          op: "collection.insert",
          args: { name: "transactions" },
        },
        "runtime-token",
      ),
    ).toBe(false);
    expect(
      isRuntimeMessage(
        {
          type: "dohc:runtime-rpc",
          token: "runtime-token",
          id: "bad",
          op: "collection.delete",
          args: { name: "transactions" },
        },
        "runtime-token",
      ),
    ).toBe(false);
  });

  it("tears down the iframe broker when the runtime navigates after the first load", async () => {
    render(<AppPackageView workspaceId="ws-apps" path="finance/.apps/ledger/app.json" />);

    const iframe = await screen.findByTestId("app-runtime-frame");
    // The first data-document load arms the broker. A later load simulates
    // self-navigation and should close it.
    fireEvent.load(iframe);
    fireEvent.load(iframe);

    expect((await screen.findByTestId("app-runtime-error")).textContent).toContain(
      "App runtime navigation was blocked.",
    );
  });

  it("brokers valid runtime messages through IPC and replies to the app frame", async () => {
    render(<AppPackageView workspaceId="ws-apps" path="finance/.apps/ledger/app.json" />);

    const iframe = (await screen.findByTestId("app-runtime-frame")) as HTMLIFrameElement;
    const frameWindow = iframe.contentWindow;
    expect(frameWindow).toBeTruthy();
    const postMessage = vi
      .spyOn(frameWindow as Window, "postMessage")
      .mockImplementation(() => undefined);

    window.dispatchEvent(
      new MessageEvent("message", {
        source: frameWindow,
        origin: "http://127.0.0.1:4477",
        data: {
          type: "dohc:runtime-rpc",
          token: "runtime-token",
          id: "rpc-1",
          op: "collection.insert",
          args: { name: "transactions", record: { id: "x" } },
        },
      }),
    );

    await waitFor(() =>
      expect(bridgeMock.runAppRuntimeRpc).toHaveBeenCalledWith({
        workspaceId: "ws-apps",
        appRoot: "finance/.apps/ledger",
        request: {
          id: "rpc-1",
          op: "collection.insert",
          args: { name: "transactions", record: { id: "x" } },
        },
      }),
    );
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        {
          type: "dohc:runtime-rpc-result",
          token: "runtime-token",
          id: "rpc-1",
          ok: true,
          value: { row: { id: "x" } },
        },
        "http://127.0.0.1:4477",
      ),
    );
  });

  it("ignores runtime messages from the wrong origin or source", async () => {
    render(<AppPackageView workspaceId="ws-apps" path="finance/.apps/ledger/app.json" />);

    const iframe = (await screen.findByTestId("app-runtime-frame")) as HTMLIFrameElement;
    const frameWindow = iframe.contentWindow;
    expect(frameWindow).toBeTruthy();
    const postMessage = vi
      .spyOn(frameWindow as Window, "postMessage")
      .mockImplementation(() => undefined);

    window.dispatchEvent(
      new MessageEvent("message", {
        source: frameWindow,
        origin: "http://evil.invalid",
        data: {
          type: "dohc:runtime-rpc",
          token: "runtime-token",
          id: "rpc-wrong-origin",
          op: "collection.list",
          args: { name: "transactions" },
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "http://127.0.0.1:4477",
        data: {
          type: "dohc:runtime-rpc",
          token: "runtime-token",
          id: "rpc-wrong-source",
          op: "collection.list",
          args: { name: "transactions" },
        },
      }),
    );

    expect(bridgeMock.runAppRuntimeRpc).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("shares the app package root instead of the inspected child path", async () => {
    const onSharePath = vi.fn();
    render(
      <AppPackageView
        workspaceId="ws-apps"
        path="finance/.apps/ledger/src/App.tsx"
        onSharePath={onSharePath}
      />,
    );

    fireEvent.click(await screen.findByTestId("file-share"));

    expect(onSharePath).toHaveBeenCalledWith("finance/.apps/ledger");
  });

  it("reports AppTester and trust failures", async () => {
    bridgeMock.runAppTester.mockRejectedValueOnce(new Error("Tester exploded"));
    render(<AppPackageView workspaceId="ws-apps" path="finance/.apps/ledger/app.json" />);

    fireEvent.click(await screen.findByTestId("run-app-tester"));
    await waitFor(() =>
      expect(screen.getByTestId("app-action-error").textContent).toBe("Tester exploded"),
    );

    cleanup();
    bridgeMock.getAppPackage.mockResolvedValueOnce({
      ...readyInfo,
      trusted: false,
      requiresTrust: true,
      readiness: "ready",
    });
    bridgeMock.grantAppTrust.mockRejectedValueOnce(new Error("Trust failed"));
    render(<AppPackageView workspaceId="ws-apps" path="finance/.apps/ledger/app.json" />);

    fireEvent.click(await screen.findByTestId("trust-app"));
    await waitFor(() =>
      expect(screen.getByTestId("app-action-error").textContent).toBe("Trust failed"),
    );
  });
});
