// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { deferred } from "../../testing/deferred";
import { bridge } from "../bridge";
import { ShellErrorReporter, type ReportShellFailure } from "../shell/useShellError";
import { CopyMessageLink, MESSAGE_LINK_FAILURE, MessageLinks, useMessageLinkMaker } from "./messageLinks";

vi.mock("../bridge", () => ({ bridge: vi.fn() }));

const LINK = `https://dohc.example/l/${"a".repeat(43)}`;

type Made = { url: string } | null;
type Sync = "on" | "paused" | undefined;

function mockBridge(makeMessageLink: (payload: { workspaceId: string; messageId: string }) => Promise<Made>) {
  const make = vi.fn(makeMessageLink);
  vi.mocked(bridge).mockReturnValue({ makeMessageLink: make } as unknown as ReturnType<typeof bridge>);
  return make;
}

// A message's Copy link inside a shell for one workspace.
function Message(props: { workspaceId: string; sync: Sync }) {
  const make = useMessageLinkMaker({ workspaceId: props.workspaceId, sync: props.sync });
  return (
    <MessageLinks.Provider value={make}>
      <CopyMessageLink messageId="m1" testId="copy-link" />
    </MessageLinks.Provider>
  );
}

beforeEach(() => {
  // user-event's setup puts a clipboard stub on navigator for the spies.
  userEvent.setup();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(bridge).mockReset();
});

describe("Copy link on a message", () => {
  it.each([undefined, "paused"] as const)("is not offered when sync is %s", (sync) => {
    mockBridge(async () => ({ url: LINK }));
    render(<Message workspaceId="w1" sync={sync} />);
    expect(screen.queryByTestId("copy-link")).toBeNull();
  });

  it("copies the link main makes for this workspace's message", async () => {
    const make = mockBridge(async () => ({ url: LINK }));
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<Message workspaceId="w1" sync="on" />);
    const button = screen.getByTestId("copy-link");
    expect(button.getAttribute("aria-label")).toBe("Copy link");

    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => expect(button.getAttribute("aria-label")).toBe("Copied"));
    expect(make).toHaveBeenCalledWith({ workspaceId: "w1", messageId: "m1" });
    expect(writeText).toHaveBeenCalledWith(LINK);
  });

  it("says a link could not be made through the shell's failure path", async () => {
    mockBridge(async () => {
      throw new Error("The workspace engine is not running.");
    });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const report: Mock<ReportShellFailure> = vi.fn();
    render(
      <ShellErrorReporter.Provider value={report}>
        <Message workspaceId="w1" sync="on" />
      </ShellErrorReporter.Provider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("copy-link"));
    });

    await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(writeText).not.toHaveBeenCalled();
    expect(report.mock.calls[0]?.[0].message).toContain(MESSAGE_LINK_FAILURE);
  });
});

describe("message link maker", () => {
  it("drops a link main made after the window changed workspaces", async () => {
    const answer = deferred<Made>();
    mockBridge(() => answer.promise);
    const hook = renderHook(({ workspaceId }) => useMessageLinkMaker({ workspaceId, sync: "on" }), {
      initialProps: { workspaceId: "a" },
    });
    const make = hook.result.current;
    if (!make) throw new Error("a syncing workspace offers links");

    const pending = make("m1");
    act(() => hook.rerender({ workspaceId: "b" }));
    answer.resolve({ url: LINK });

    await expect(pending).resolves.toBeNull();
    hook.unmount();
  });

  it("keeps a link for the workspace that asked", async () => {
    mockBridge(async () => ({ url: LINK }));
    const hook = renderHook(() => useMessageLinkMaker({ workspaceId: "a", sync: "on" }));
    const make = hook.result.current;
    if (!make) throw new Error("a syncing workspace offers links");

    await expect(make("m1")).resolves.toBe(LINK);
    hook.unmount();
  });

  it("offers no maker for a workspace that does not sync", () => {
    const hook = renderHook(() => useMessageLinkMaker({ workspaceId: "a", sync: undefined }));
    expect(hook.result.current).toBeNull();
    hook.unmount();
  });
});
