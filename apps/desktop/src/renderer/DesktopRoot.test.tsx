// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopRoot } from "./DesktopRoot";
import type { Workspace } from "./DesktopWorkspaceShell";

vi.mock("./DesktopFirstRun", () => ({
  DesktopFirstRun: () => <div data-testid="first-run" />,
}));

vi.mock("./DesktopWorkspaceShell", () => ({
  DesktopWorkspaceShell: (props: {
    workspace: Workspace;
    workspaces: Workspace[];
  }) => (
    <div data-testid="workspace-shell">
      <span data-testid="active-workspace">{props.workspace.workspaceId}</span>
      <span data-testid="workspace-count">{props.workspaces.length}</span>
    </div>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function workspace(workspaceId: string): Workspace {
  return {
    workspaceId,
    rootPath: `/tmp/${workspaceId}`,
    kind: "personal",
    mode: "local-first",
  };
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("DesktopRoot", () => {
  it("does not let a delayed registry load clobber an activated workspace", async () => {
    const registry = deferred<{ workspaces: Workspace[] }>();
    let activate: ((workspace: Workspace) => void) | null = null;
    vi.stubGlobal("dohcDesktop", {
      getWorkspaceRegistry: vi.fn(() => registry.promise),
      onWorkspaceActivated: vi.fn((callback: (workspace: Workspace) => void) => {
        activate = callback;
        return () => undefined;
      }),
    });

    render(<DesktopRoot />);
    await act(async () => {
      activate?.(workspace("activated"));
      registry.resolve({ workspaces: [workspace("registry-default")] });
    });

    expect((await screen.findByTestId("active-workspace")).textContent).toBe("activated");
    expect(screen.getByTestId("workspace-count").textContent).toBe("2");
  });
});
