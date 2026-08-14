// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { startTransition, StrictMode, Suspense } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { EngineYDocSaveStateEvent } from "../../ipc/channels";
import { resetOrphanedDrafts } from "../orphanedDrafts";
import {
  disposeEngineDocLeasesForTests,
  useEngineDoc,
} from "./useEngineDoc";

type SaveStateListener = (event: EngineYDocSaveStateEvent) => void;

function sharedBridge() {
  const saveStateListeners = new Set<SaveStateListener>();
  const remoteUpdateListeners = new Set<
    (event: {
      sessionId: string;
      update: Uint8Array;
      lineageGeneration: number;
    }) => void
  >();
  const openedSessionIds: string[] = [];
  let closeGate: Promise<void> | null = null;
  let openGate: Promise<void> | null = null;
  let openError: Error | null = null;
  let remoteUnsubscribeError: Error | null = null;
  const source = new Y.Doc();
  source.getMap("meta").set("contentKind", "plain-text");
  source.getText("plainText").insert(0, "seed");

  const api = {
    openEngineYDocSession: vi.fn(
      async (payload: { sessionId: string }) => {
        openedSessionIds.push(payload.sessionId);
        await openGate;
        if (openError) {
          const error = openError;
          openError = null;
          throw error;
        }
        return {
          available: true,
          initialUpdate: Y.encodeStateAsUpdate(source),
          lineageGeneration: 1,
        };
      },
    ),
    applyEngineYDocUpdate: vi.fn(async () => ({ accepted: true as const })),
    onEngineYDocRemoteUpdate: (
      listener: (event: {
        sessionId: string;
        update: Uint8Array;
        lineageGeneration: number;
      }) => void,
    ) => {
      remoteUpdateListeners.add(listener);
      return () => {
        remoteUpdateListeners.delete(listener);
        if (remoteUnsubscribeError) {
          const error = remoteUnsubscribeError;
          remoteUnsubscribeError = null;
          throw error;
        }
      };
    },
    onEngineYDocSaveState: (listener: SaveStateListener) => {
      saveStateListeners.add(listener);
      return () => saveStateListeners.delete(listener);
    },
    onEngineYDocLineageReplacement: () => () => undefined,
    acknowledgeEngineYDocLineageReplacement: vi.fn(async () => ({ updates: [] })),
    closeEngineYDocSession: vi.fn(async () => {
      await closeGate;
    }),
  };

  function emit(
    state: EngineYDocSaveStateEvent["state"],
    seq: number,
  ): void {
    const sessionId = openedSessionIds.at(-1);
    if (!sessionId) throw new Error("session not open yet");
    act(() => {
      for (const listener of [...saveStateListeners]) {
        listener({ sessionId, state, seq });
      }
    });
  }

  return {
    api,
    emit,
    openedSessionIds,
    failNextOpen(error = new Error("engine unavailable")) {
      openError = error;
    },
    holdNextOpen() {
      let release!: () => void;
      openGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        openGate = null;
        release();
      };
    },
    failNextRemoteUnsubscribe(error = new Error("unsubscribe failed")) {
      remoteUnsubscribeError = error;
    },
    holdClose() {
      let release!: () => void;
      closeGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        closeGate = null;
        release();
      };
    },
  };
}

const renderedDocs = new Map<string, Y.Doc | null>();

function Consumer(props: {
  id: string;
  reopenKey: number;
  retryKey: number;
}) {
  const engine = useEngineDoc({
    workspaceId: "ws-1",
    path: "notes/a.md",
    enabled: true,
    reopenKey: props.reopenKey,
    retryKey: props.retryKey,
  });
  renderedDocs.set(props.id, engine.doc);
  return (
    <div>
      <span data-testid={"available-" + props.id}>
        {String(engine.available)}
      </span>
      <span data-testid={"opening-" + props.id}>{String(engine.opening)}</span>
      <span data-testid={"state-" + props.id}>{engine.saveState}</span>
      <span data-testid={"deleted-" + props.id}>
        {String(engine.deletedWhileEditing)}
      </span>
      <button
        data-testid={"type-" + props.id}
        type="button"
        onClick={() => {
          const text = engine.doc?.getText("plainText");
          text?.insert(text.length, "!");
        }}
      >
        type
      </button>
    </div>
  );
}

function SuspendingConsumer(props: {
  retryKey: number;
  suspend: boolean;
  onSuspend: () => void;
}) {
  const engine = useEngineDoc({
    workspaceId: "ws-1",
    path: "notes/a.md",
    enabled: true,
    reopenKey: 0,
    retryKey: props.retryKey,
  });
  if (props.suspend) {
    props.onSuspend();
    throw new Promise<never>(() => undefined);
  }
  return (
    <>
      <span data-testid="available-suspending">
        {String(engine.available)}
      </span>
      <span data-testid="opening-suspending">{String(engine.opening)}</span>
    </>
  );
}

function Pair(props: {
  showFirst?: boolean;
  reopenKey?: number;
  retryKey?: number;
  firstRetryKey?: number;
  secondRetryKey?: number;
}) {
  const reopenKey = props.reopenKey ?? 0;
  const retryKey = props.retryKey ?? 0;
  return (
    <>
      {props.showFirst === false ? null : (
        <Consumer
          id="first"
          reopenKey={reopenKey}
          retryKey={props.firstRetryKey ?? retryKey}
        />
      )}
      <Consumer
        id="second"
        reopenKey={reopenKey}
        retryKey={props.secondRetryKey ?? retryKey}
      />
    </>
  );
}

function SplitAfterRetry(props: {
  showSecond: boolean;
  firstRetryKey?: number;
  secondRetryKey?: number;
  secondReopenKey?: number;
}) {
  return (
    <>
      <Consumer
        id="first"
        reopenKey={0}
        retryKey={props.firstRetryKey ?? 1}
      />
      {props.showSecond ? (
        <Consumer
          id="second"
          reopenKey={props.secondReopenKey ?? 0}
          retryKey={props.secondRetryKey ?? 0}
        />
      ) : null}
    </>
  );
}

let harness: ReturnType<typeof sharedBridge>;

beforeEach(() => {
  renderedDocs.clear();
  resetOrphanedDrafts();
  harness = sharedBridge();
  vi.stubGlobal("dohcDesktop", harness.api);
});

afterEach(async () => {
  cleanup();
  await disposeEngineDocLeasesForTests();
  vi.unstubAllGlobals();
  resetOrphanedDrafts();
});

async function waitForPair(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId("available-first").textContent).toBe("true");
    expect(screen.getByTestId("available-second").textContent).toBe("true");
  });
}

it("keeps one lease through React StrictMode's effect replay", async () => {
  const view = render(
    <StrictMode>
      <Pair />
    </StrictMode>,
  );
  await waitForPair();

  expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(1);
  expect(renderedDocs.get("second")).toBe(renderedDocs.get("first"));
  expect(harness.api.closeEngineYDocSession).not.toHaveBeenCalled();

  view.unmount();
  await waitFor(() =>
    expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(1),
  );
});

it("ignores retry identity from an abandoned render", async () => {
  let suspended = false;
  const renderConsumer = (retryKey: number, suspend: boolean) => (
    <Suspense fallback={null}>
      <SuspendingConsumer
        retryKey={retryKey}
        suspend={suspend}
        onSuspend={() => {
          suspended = true;
        }}
      />
    </Suspense>
  );
  const view = render(renderConsumer(0, false));
  await waitFor(() =>
    expect(screen.getByTestId("available-suspending").textContent).toBe(
      "true",
    ),
  );

  await act(async () => {
    startTransition(() => view.rerender(renderConsumer(1, true)));
    await Promise.resolve();
  });
  expect(suspended).toBe(true);

  view.rerender(renderConsumer(0, false));
  expect(screen.getByTestId("available-suspending").textContent).toBe("true");
  expect(screen.getByTestId("opening-suspending").textContent).toBe("false");
  expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(1);
});

it.each([
  { request: "retry", reopenKey: 0, retryKey: 1 },
  { request: "active version change", reopenKey: 1, retryKey: 0 },
])("closes the final consumer before a $request replacement", async (next) => {
  const view = render(<Consumer id="first" reopenKey={0} retryKey={0} />);
  await waitFor(() =>
    expect(screen.getByTestId("available-first").textContent).toBe("true"),
  );
  const releaseClose = harness.holdClose();

  view.rerender(
    <Consumer
      id="first"
      reopenKey={next.reopenKey}
      retryKey={next.retryKey}
    />,
  );
  await waitFor(() =>
    expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(1),
  );

  try {
    expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("available-first").textContent).toBe("false");
  } finally {
    releaseClose();
  }
  await waitFor(() =>
    expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(2),
  );
  await waitFor(() =>
    expect(screen.getByTestId("available-first").textContent).toBe("true"),
  );
});

it("shares one document lease until the final consumer unmounts", async () => {
  const view = render(<Pair />);
  await waitForPair();

  const sharedDoc = renderedDocs.get("first");
  expect(sharedDoc).toBeInstanceOf(Y.Doc);
  expect(renderedDocs.get("second")).toBe(sharedDoc);
  expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByTestId("type-first"));
  await waitFor(() => {
    expect(screen.getByTestId("state-first").textContent).toBe("saving");
    expect(screen.getByTestId("state-second").textContent).toBe("saving");
  });
  expect(harness.api.applyEngineYDocUpdate).toHaveBeenCalledTimes(1);

  harness.emit("saved", 1);
  expect(screen.getByTestId("state-first").textContent).toBe("saved");
  expect(screen.getByTestId("state-second").textContent).toBe("saved");

  harness.emit("deleted", 1);
  expect(screen.getByTestId("deleted-first").textContent).toBe("true");
  expect(screen.getByTestId("deleted-second").textContent).toBe("true");
  expect(screen.getByTestId("state-first").textContent).toBe("deleted");
  expect(screen.getByTestId("state-second").textContent).toBe("deleted");

  view.rerender(<Pair showFirst={false} />);
  expect(harness.api.closeEngineYDocSession).not.toHaveBeenCalled();
  expect(screen.getByTestId("available-second").textContent).toBe("true");
  expect(renderedDocs.get("second")).toBe(sharedDoc);

  view.unmount();
  await waitFor(() =>
    expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(1),
  );
});

it("settles a failed shared open for both consumers", async () => {
  harness.failNextOpen();
  const rejectOpen = harness.holdNextOpen();
  const view = render(<Pair />);

  await waitFor(() =>
    expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(1),
  );
  expect(screen.getByTestId("available-first").textContent).toBe("false");
  expect(screen.getByTestId("available-second").textContent).toBe("false");
  expect(screen.getByTestId("opening-first").textContent).toBe("true");
  expect(screen.getByTestId("opening-second").textContent).toBe("true");

  rejectOpen();
  await waitFor(() => {
    expect(screen.getByTestId("opening-first").textContent).toBe("false");
    expect(screen.getByTestId("opening-second").textContent).toBe("false");
    expect(screen.getByTestId("available-first").textContent).toBe("false");
    expect(screen.getByTestId("available-second").textContent).toBe("false");
  });
  expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(1);

  view.unmount();
  await expect(disposeEngineDocLeasesForTests()).resolves.toBeUndefined();
});

it("continues shared retries after a session cleanup rejects", async () => {
  const cleanupError = new Error("unsubscribe failed");
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  const view = render(<Pair />);
  await waitForPair();
  harness.failNextRemoteUnsubscribe(cleanupError);

  view.rerender(<Pair firstRetryKey={1} />);
  await waitFor(() =>
    expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(2),
  );
  await waitForPair();

  view.rerender(<Pair firstRetryKey={2} />);
  await waitFor(() =>
    expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(3),
  );
  await waitForPair();
  expect(consoleError).toHaveBeenCalledWith(
    "[desktop] could not fully clean up a live document session:",
    cleanupError,
  );

  view.unmount();
  await waitFor(() =>
    expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(2),
  );
  consoleError.mockRestore();
});

it("attaches a newly split consumer to the lease retained after retry", async () => {
  const view = render(
    <SplitAfterRetry showSecond={false} firstRetryKey={0} />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available-first").textContent).toBe("true"),
  );
  const initialDoc = renderedDocs.get("first");

  view.rerender(
    <SplitAfterRetry showSecond={false} firstRetryKey={1} />,
  );
  await waitFor(() => {
    expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("available-first").textContent).toBe("true");
    expect(renderedDocs.get("first")).not.toBe(initialDoc);
  });
  const retriedDoc = renderedDocs.get("first");
  expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(1);

  view.rerender(<SplitAfterRetry showSecond firstRetryKey={1} />);
  await waitForPair();

  expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(2);
  expect(renderedDocs.get("second")).toBe(retriedDoc);
  expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(1);

  view.unmount();
  await waitFor(() =>
    expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(2),
  );
});

it("reopens one shared lease when only one mounted consumer retries", async () => {
  const view = render(<Pair />);
  await waitForPair();
  const initialDoc = renderedDocs.get("first");

  view.rerender(<Pair firstRetryKey={1} />);
  await waitFor(() => {
    expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(2);
    expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(1);
    expect(renderedDocs.get("first")).not.toBe(initialDoc);
    expect(renderedDocs.get("second")).toBe(renderedDocs.get("first"));
  });
  // The pane that did NOT retry has to come back with the shared session, not
  // sit in the opening state waiting for a request key it never asked for.
  // Without this, two nulls satisfy the identity check above.
  await waitForPair();
  expect(screen.getByTestId("opening-second").textContent).toBe("false");
  expect(renderedDocs.get("second")).not.toBeNull();

  const closeOrder =
    harness.api.closeEngineYDocSession.mock.invocationCallOrder[0];
  const secondOpenOrder =
    harness.api.openEngineYDocSession.mock.invocationCallOrder[1];
  expect(closeOrder!).toBeLessThan(secondOpenOrder!);

  view.unmount();
  await waitFor(() =>
    expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(2),
  );
});

it("treats a later pane's first retry as its own request", async () => {
  const view = render(
    <SplitAfterRetry showSecond={false} firstRetryKey={0} />,
  );
  await waitFor(() =>
    expect(screen.getByTestId("available-first").textContent).toBe("true"),
  );

  view.rerender(
    <SplitAfterRetry showSecond={false} firstRetryKey={1} />,
  );
  await waitFor(() => {
    expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(2);
    expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(1);
  });

  view.rerender(
    <SplitAfterRetry showSecond firstRetryKey={1} secondRetryKey={0} />,
  );
  await waitForPair();
  const firstRetriedDoc = renderedDocs.get("first");
  expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(2);
  expect(renderedDocs.get("second")).toBe(firstRetriedDoc);

  view.rerender(
    <SplitAfterRetry showSecond firstRetryKey={1} secondRetryKey={1} />,
  );
  await waitFor(() => {
    expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(3);
    expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(2);
    expect(renderedDocs.get("first")).not.toBe(firstRetriedDoc);
    expect(renderedDocs.get("second")).toBe(renderedDocs.get("first"));
  });

  view.unmount();
  await waitFor(() =>
    expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(3),
  );
});

it("does not reuse a retained lease from another active version", async () => {
  const view = render(<SplitAfterRetry showSecond={false} />);
  await waitFor(() =>
    expect(screen.getByTestId("available-first").textContent).toBe("true"),
  );
  const firstVersionDoc = renderedDocs.get("first");

  view.rerender(<SplitAfterRetry showSecond secondReopenKey={1} />);
  await waitForPair();

  expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(2);
  expect(renderedDocs.get("second")).not.toBe(firstVersionDoc);

  view.unmount();
  await waitFor(() =>
    expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(2),
  );
});

it("closes a pending old-version open before opening the replacement version", async () => {
  const releaseOpen = harness.holdNextOpen();
  const view = render(<Pair reopenKey={1} />);
  await waitFor(() =>
    expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(1),
  );

  view.rerender(<Pair reopenKey={2} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(1);

  releaseOpen();
  await waitFor(() => {
    expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(1);
    expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("available-first").textContent).toBe("true");
    expect(screen.getByTestId("available-second").textContent).toBe("true");
  });
  expect(
    harness.api.closeEngineYDocSession.mock.invocationCallOrder[0],
  ).toBeLessThan(
    harness.api.openEngineYDocSession.mock.invocationCallOrder[1]!,
  );

  view.unmount();
  await waitFor(() =>
    expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(2),
  );
});

it("opens one fresh shared lease for each version or retry key", async () => {
  const view = render(<Pair reopenKey={1} retryKey={0} />);
  await waitForPair();
  const firstVersionDoc = renderedDocs.get("first");
  expect(renderedDocs.get("second")).toBe(firstVersionDoc);
  expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(1);

  view.rerender(<Pair reopenKey={2} retryKey={0} />);
  await waitFor(() =>
    expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(2),
  );
  await waitForPair();
  const secondVersionDoc = renderedDocs.get("first");
  expect(secondVersionDoc).not.toBe(firstVersionDoc);
  expect(renderedDocs.get("second")).toBe(secondVersionDoc);
  expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(1);

  view.rerender(<Pair reopenKey={2} retryKey={1} />);
  await waitFor(() =>
    expect(harness.api.openEngineYDocSession).toHaveBeenCalledTimes(3),
  );
  await waitForPair();
  const retryDoc = renderedDocs.get("first");
  expect(retryDoc).not.toBe(secondVersionDoc);
  expect(renderedDocs.get("second")).toBe(retryDoc);
  expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(2);

  view.unmount();
  await waitFor(() =>
    expect(harness.api.closeEngineYDocSession).toHaveBeenCalledTimes(3),
  );
});
