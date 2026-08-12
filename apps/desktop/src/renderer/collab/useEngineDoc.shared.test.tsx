// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
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
    (event: { sessionId: string; update: Uint8Array }) => void
  >();
  const openedSessionIds: string[] = [];
  const source = new Y.Doc();
  source.getMap("meta").set("contentKind", "plain-text");
  source.getText("plainText").insert(0, "seed");

  const api = {
    openEngineYDocSession: vi.fn(
      async (payload: { sessionId: string }) => {
        openedSessionIds.push(payload.sessionId);
        return {
          available: true,
          initialUpdate: Y.encodeStateAsUpdate(source),
        };
      },
    ),
    applyEngineYDocUpdate: vi.fn(async () => undefined),
    onEngineYDocRemoteUpdate: (
      listener: (event: { sessionId: string; update: Uint8Array }) => void,
    ) => {
      remoteUpdateListeners.add(listener);
      return () => remoteUpdateListeners.delete(listener);
    },
    onEngineYDocSaveState: (listener: SaveStateListener) => {
      saveStateListeners.add(listener);
      return () => saveStateListeners.delete(listener);
    },
    closeEngineYDocSession: vi.fn(async () => undefined),
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

  return { api, emit, openedSessionIds };
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

function Pair(props: {
  showFirst?: boolean;
  reopenKey?: number;
  retryKey?: number;
}) {
  const reopenKey = props.reopenKey ?? 0;
  const retryKey = props.retryKey ?? 0;
  return (
    <>
      {props.showFirst === false ? null : (
        <Consumer id="first" reopenKey={reopenKey} retryKey={retryKey} />
      )}
      <Consumer id="second" reopenKey={reopenKey} retryKey={retryKey} />
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
