// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedWithMeList } from "./SharedWithMeList";

let activity: (() => void) | null = null;

const bridgeMock = {
  listRelayShares: vi.fn(),
  getWorkspaceRegistry: vi.fn(),
  unmountShare: vi.fn(),
  mountShare: vi.fn(),
  dismissShareSkips: vi.fn(),
  onWorkspaceActivity: vi.fn((listener: () => void) => {
    activity = listener;
    return () => {
      activity = null;
    };
  }),
};

vi.mock("../bridge", () => ({
  bridge: () => bridgeMock,
}));

const WORKSPACE_ID = "ws-host";

const SKIPPED = {
  ops: [
    {
      originId: "origin-granter",
      originSeq: 7,
      opKind: "moment.append",
      code: "share-boundary-violation",
      detail:
        "replicated moment is outside the share boundary: the share granted " +
        "version main, the relay offered version version-other",
      atMs: 1000,
    },
  ],
  more: 0,
  generation: 3,
  acknowledgedGeneration: 0,
  counted: ["origin-granter\u00007"],
};

beforeEach(() => {
  vi.resetAllMocks();
  activity = null;
  bridgeMock.onWorkspaceActivity.mockImplementation((listener: () => void) => {
    activity = listener;
    return () => {
      activity = null;
    };
  });
  bridgeMock.listRelayShares.mockResolvedValue({ received: [] });
  bridgeMock.unmountShare.mockResolvedValue(undefined);
  bridgeMock.dismissShareSkips.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("SharedWithMeList", () => {
  // A mounted share's pull skips a refused op and keeps going, so the mount
  // goes on looking healthy while it stops carrying part of what the granter
  // shares. The mount row is where a recipient sees that — the workspace
  // banner only speaks for a standalone shared view.
  it("says when a mounted share's pulls skipped ops it does not cover", async () => {
    bridgeMock.getWorkspaceRegistry.mockResolvedValue({
      workspaces: [
        {
          workspaceId: WORKSPACE_ID,
          shareMounts: [
            {
              shareId: "share-1",
              label: "alex",
              granterEmail: "alex@dohc.test",
              skippedOps: SKIPPED,
            },
          ],
        },
      ],
    });

    render(<SharedWithMeList workspaceId={WORKSPACE_ID} />);

    const skipped = await screen.findByTestId("shared-with-me-skipped");
    expect(skipped.getAttribute("data-kind")).toBe("boundary");
    expect(
      skipped.textContent,
      "MUTATION: a mount's refusals stay console-only and the recipient never learns the content is missing",
    ).toContain("dohc skipped 1 update outside what this share covers");
    expect(skipped.getAttribute("title")).toContain("version-other");
  });

  // The warning says it stays until dismissed, so the control has to exist and
  // has to clear the MOUNT's record — not the workspace's shared view, and not
  // only this render.
  it("dismisses a mounted share's skip record through the mount's own id", async () => {
    let mounts = [
      {
        shareId: "share-1",
        label: "alex",
        granterEmail: "alex@dohc.test",
        skippedOps: SKIPPED,
      },
    ];
    bridgeMock.getWorkspaceRegistry.mockImplementation(async () => ({
      workspaces: [{ workspaceId: WORKSPACE_ID, shareMounts: mounts }],
    }));
    bridgeMock.dismissShareSkips.mockImplementation(async () => {
      mounts = [
        { shareId: "share-1", label: "alex", granterEmail: "alex@dohc.test" },
      ] as typeof mounts;
    });

    render(<SharedWithMeList workspaceId={WORKSPACE_ID} />);
    await userEvent.click(
      await screen.findByTestId("shared-with-me-skipped-dismiss"),
    );

    expect(
      bridgeMock.dismissShareSkips,
      "MUTATION: without the mount's shareId the notice can only be cleared by removing the mount",
    ).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      shareId: "share-1",
      // The generation on screen, so a refusal recorded since this render
      // survives the click.
      generation: 3,
    });
    await waitFor(() => {
      expect(screen.queryByTestId("shared-with-me-skipped")).toBeNull();
    });
  });

  // The pull runs in main and writes the record as it goes, so a refusal can
  // land while this list is open. Without following the activity signal the
  // row keeps showing the snapshot it loaded and says nothing until Settings
  // is reopened.
  it("picks up a refusal recorded while the list is open", async () => {
    let mounts: Array<Record<string, unknown>> = [
      { shareId: "share-1", label: "alex", granterEmail: "alex@dohc.test" },
    ];
    bridgeMock.getWorkspaceRegistry.mockImplementation(async () => ({
      workspaces: [{ workspaceId: WORKSPACE_ID, shareMounts: mounts }],
    }));

    render(<SharedWithMeList workspaceId={WORKSPACE_ID} />);
    await screen.findByTestId("shared-with-me-row");
    expect(screen.queryByTestId("shared-with-me-skipped")).toBeNull();

    // A pull records a refusal and main notifies the renderer.
    mounts = [
      {
        shareId: "share-1",
        label: "alex",
        granterEmail: "alex@dohc.test",
        skippedOps: SKIPPED,
      },
    ];
    activity?.();

    expect(
      await screen.findByTestId("shared-with-me-skipped"),
      "MUTATION: a one-time snapshot leaves the open row silent while content goes missing",
    ).toBeTruthy();
    // The registry only. Workspace activity fires on every settled watcher
    // batch, and a full refresh would put a /sync/shares request on the wire
    // for each one — the token stops a stale answer landing, not the request.
    expect(
      bridgeMock.listRelayShares,
      "MUTATION: following activity with a full refresh puts a relay listing on the wire per watcher batch",
    ).toHaveBeenCalledTimes(1);
  });

  // Activity fires while the INITIAL load is still waiting on the relay
  // listing. The registry-only reload must not cancel that lookup: one
  // counter answering both "may this response land?" and "is that reader
  // superseded?" left the panel stuck on "Loading shares sent to you…" until
  // Settings was closed and reopened.
  it("reaches ready when activity fires during the initial load", async () => {
    let releaseShares: (value: { received: unknown[] }) => void = () => {};
    bridgeMock.listRelayShares.mockImplementation(
      async () =>
        await new Promise<{ received: unknown[] }>((resolve) => {
          releaseShares = resolve;
        }),
    );
    bridgeMock.getWorkspaceRegistry.mockResolvedValue({
      workspaces: [
        {
          workspaceId: WORKSPACE_ID,
          shareMounts: [
            {
              shareId: "share-1",
              label: "alex",
              granterEmail: "alex@dohc.test",
              skippedOps: SKIPPED,
            },
          ],
        },
      ],
    });

    render(<SharedWithMeList workspaceId={WORKSPACE_ID} />);
    // The listing has not answered yet; a watcher batch settles.
    activity?.();
    await waitFor(() => {
      expect(bridgeMock.getWorkspaceRegistry.mock.calls.length).toBeGreaterThan(1);
    });
    // Now the relay answers.
    releaseShares({ received: [] });

    expect(
      await screen.findByTestId("shared-with-me-row"),
      "MUTATION: sharing one token lets an activity reload cancel the initial relay lookup, and the panel never leaves Loading",
    ).toBeTruthy();
    expect(screen.getByTestId("shared-with-me-skipped")).toBeTruthy();
  });

  // A refusal recorded while the panel is still LOADING. The registry lane
  // reads it, has nowhere to paint it, and that activity signal is the only
  // one that refusal gets — dropping the value here leaves the warning hidden
  // until some unrelated event fires. It is held instead, and the full
  // refresh publishes it the moment it lands.
  it("shows a refusal recorded during the initial load, with no second signal", async () => {
    let releaseShares: (value: { received: unknown[] }) => void = () => {};
    bridgeMock.listRelayShares.mockImplementation(
      async () =>
        await new Promise<{ received: unknown[] }>((resolve) => {
          releaseShares = resolve;
        }),
    );
    // The registry the INITIAL refresh reads: healthy.
    let mounts: Array<Record<string, unknown>> = [
      { shareId: "share-1", label: "alex", granterEmail: "alex@dohc.test" },
    ];
    bridgeMock.getWorkspaceRegistry.mockImplementation(async () => ({
      workspaces: [{ workspaceId: WORKSPACE_ID, shareMounts: mounts }],
    }));

    render(<SharedWithMeList workspaceId={WORKSPACE_ID} />);
    // Still loading: the relay has not answered. A pull records a refusal and
    // fires the one activity signal it gets.
    mounts = [
      {
        shareId: "share-1",
        label: "alex",
        granterEmail: "alex@dohc.test",
        skippedOps: SKIPPED,
      },
    ];
    activity?.();
    await waitFor(() => {
      expect(bridgeMock.getWorkspaceRegistry.mock.calls.length).toBeGreaterThan(1);
    });

    // The relay answers, carrying the older registry snapshot behind it.
    releaseShares({ received: [] });

    expect(
      await screen.findByTestId("shared-with-me-skipped"),
      "MUTATION: a registry read dropped during loading consumes the only signal that refusal gets",
    ).toBeTruthy();
  });

  // The two lanes commit different fields. A full refresh that started before
  // a registry commit read older mounts, so it publishes its listing and
  // keeps the fresher rows — a skip warning must not blink out and back.
  it("does not revert mounts a registry reload committed while it was in flight", async () => {
    let mounts: Array<Record<string, unknown>> = [
      { shareId: "share-1", label: "alex", granterEmail: "alex@dohc.test" },
    ];
    bridgeMock.getWorkspaceRegistry.mockImplementation(async () => ({
      workspaces: [{ workspaceId: WORKSPACE_ID, shareMounts: mounts }],
    }));
    render(<SharedWithMeList workspaceId={WORKSPACE_ID} />);
    await screen.findByTestId("shared-with-me-row");

    // A refresh starts and stalls on the relay listing.
    let releaseShares: (value: { received: unknown[] }) => void = () => {};
    bridgeMock.listRelayShares.mockImplementation(
      async () =>
        await new Promise<{ received: unknown[] }>((resolve) => {
          releaseShares = resolve;
        }),
    );
    void bridgeMock.unmountShare.mockResolvedValue(undefined);
    const refreshStarted = screen.getByTestId("shared-with-me-unmount");
    await userEvent.click(refreshStarted);

    // While it waits, a pull records a refusal and activity fires.
    mounts = [
      {
        shareId: "share-1",
        label: "alex",
        granterEmail: "alex@dohc.test",
        skippedOps: SKIPPED,
      },
    ];
    activity?.();
    await screen.findByTestId("shared-with-me-skipped");

    // The stalled listing lands with the OLDER registry snapshot behind it,
    // carrying a share that only IT can render — so the assertion below runs
    // after that state landed, not before it.
    releaseShares({
      received: [
        {
          shareId: "share-2",
          granterEmail: "sam@dohc.test",
          selector: { paths: ["docs"], versionId: null },
          createdAtMs: 1,
          shareCode: "dohc-share:share-2:http://relay.test",
        },
      ],
    });
    await screen.findByText("docs");

    expect(
      screen.queryByTestId("shared-with-me-skipped"),
      "MUTATION: the slower lane republishes its stale mounts and the warning blinks out",
    ).not.toBeNull();
  });

  // The row must not tell the reader a malformed envelope is something the
  // share excluded, nor send them to the granter about it.
  it("says a malformed update could not be applied, without blaming the share", async () => {
    bridgeMock.getWorkspaceRegistry.mockResolvedValue({
      workspaces: [
        {
          workspaceId: WORKSPACE_ID,
          shareMounts: [
            {
              shareId: "share-1",
              label: "alex",
              granterEmail: "alex@dohc.test",
              skippedOps: {
                ...SKIPPED,
                ops: [
                  {
                    ...SKIPPED.ops[0],
                    code: "invalid-input",
                    detail:
                      "invalid replication input: op_kind must be non-empty and bounded: at most 128 bytes, offered 200 bytes",
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    render(<SharedWithMeList workspaceId={WORKSPACE_ID} />);

    const line = await screen.findByTestId("shared-with-me-skipped");
    expect(line.getAttribute("data-kind")).toBe("malformed");
    expect(
      line.textContent,
      "MUTATION: a malformed envelope rendered as 'outside what this share covers' is a false cause and a false instruction",
    ).toContain("dohc couldn't apply 1 update this share sent.");
    expect(line.textContent).not.toContain("alex@dohc.test");
    expect(line.getAttribute("title")).toContain("offered 200 bytes");
  });

  it("shows no skip line for a healthy mount", async () => {
    bridgeMock.getWorkspaceRegistry.mockResolvedValue({
      workspaces: [
        {
          workspaceId: WORKSPACE_ID,
          shareMounts: [
            { shareId: "share-1", label: "alex", granterEmail: "alex@dohc.test" },
          ],
        },
      ],
    });

    render(<SharedWithMeList workspaceId={WORKSPACE_ID} />);

    await screen.findByTestId("shared-with-me-row");
    expect(screen.queryByTestId("shared-with-me-skipped")).toBeNull();
  });
});
